// backend/services/itOps.js
// IT operations checks (2026-11-25), shown on frontend admin/ItOps.tsx:
//   1. servers  -- every active Windows server, from its own report
//                  (scripts/pc/Send-PcReport.ps1 also runs on servers) + AD
//   2. backups  -- Veeam jobs + repositories, from the backup host's
//                  scripts/veeam/Send-VeeamStatus.ps1 ('backup' snapshot)
//   3. AD + DNS -- stale accounts, old passwords, admin groups, junk records
//                  on the domain name, unsafe zone settings, from each DC's
//                  Send-NetworkInventory.ps1 -Parts hygiene ('hygiene_<DOMAIN>')
//   4. expiry   -- TLS certificates checked from here (tls.connect) and the
//                  IT Licenses tracker
// Every check becomes an issue {key, area, severity, code, target, params};
// the monitor pushes a phone alert when a new critical issue appears and when
// it clears. Read-only everywhere: nothing here changes a server or AD.
import tls from 'tls';
import { NetworkSnapshot } from '../models/Network.js';
import { ItLicense } from '../models/ItLicense.js';
import { buildDeviceList, isActiveDevice, loadSnapshots } from './networkInventory.js';
import { pushAlert, saveSnapshot } from './networkMonitor.js';

const DAY = 86400000;
const CERT_INTERVAL_MS = 6 * 3600 * 1000;
const ALERT_INTERVAL_MS = 15 * 60 * 1000;

export const OPS_LIMITS = {
    serverReportHours: 12, // servers report every 4 h; 3 missed runs = old
    clockSkewSeconds: 120,
    clockSkewCriticalSeconds: 300,
    repoLowPct: 15,
    repoCriticalPct: 8,
    backupDataHours: 6, // the Veeam script runs hourly
    hygieneDataHours: 6, // DC hygiene runs hourly
    certWarnDays: 30,
    certCriticalDays: 14,
    licenseWarnDays: 30,
};

// Server health issues from summarizeHealth that matter on a server, and how
// bad they are. uptime_long is left out: servers are meant to run for weeks.
const SERVER_HEALTH = {
    av_none: 'critical',
    av_off: 'critical',
    av_outdated: 'warning',
    av_service_stopped: 'warning',
    low_disk: 'critical',
    pool_high: 'warning',
    memory_high: 'warning',
    reboot_pending: 'warning',
    updates_old: 'warning',
    os_unsupported: 'warning',
};

const issue = (area, severity, code, target, params = {}) => ({
    key: `${area}:${code}:${target}`,
    area,
    severity,
    code,
    target,
    params,
});

const ageHours = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3600000 : null);
const isServerOs = (os) => /server/i.test(os || '');

// ---------------------------------------------------------------------------
// 1. servers
// ---------------------------------------------------------------------------

function serverRows(devices) {
    const out = [];
    for (const d of devices) {
        const os = d.pc?.os?.caption || d.ad?.os || '';
        if (!isServerOs(os)) continue;
        if (d.ad && d.ad.enabled === false) continue;
        if (!d.pc && !isActiveDevice(d, 30)) continue;
        const p = d.pc;
        const reportAge = ageHours(p?.reportedAt);
        const skew = p?.server?.clientTimeUtc && p.reportedAt
            ? Math.round((Date.parse(p.server.clientTimeUtc) - Date.parse(p.reportedAt)) / 1000)
            : null;
        const volumes = (p?.hardware?.volumes ?? [])
            .filter((v) => v?.sizeGb > 0)
            .map((v) => ({
                drive: v.drive ?? v.letter ?? v.name ?? null,
                sizeGb: v.sizeGb,
                freeGb: v.freeGb,
                freePct: Math.round((v.freeGb / v.sizeGb) * 100),
            }));
        out.push({
            name: d.name || d.ad?.name || p?.computerName,
            domain: d.ad?.domain ?? null,
            ip: d.ip ?? null,
            online: Boolean(d.online),
            os,
            osSupported: d.osSupported ?? null,
            adLastLogon: d.ad?.lastLogon ?? null,
            reportedAt: p?.reportedAt ?? null,
            reportAgeHours: reportAge === null ? null : Math.round(reportAge * 10) / 10,
            lastBoot: p?.os?.lastBoot ?? null,
            psVersion: p?.server?.psVersion ?? null,
            av: d.health?.av ?? null,
            healthIssues: d.health?.issues ?? [],
            volumes,
            ramGb: p?.hardware?.ramGb ?? null,
            ramFreeGb: p?.hardware?.ramFreeGb ?? null,
            rebootPending: p?.health?.rebootPending ?? null,
            lastUpdate: p?.health?.updates?.lastInstalled ?? null,
            stoppedServices: p?.server?.stoppedServices ?? [],
            clockSkewSeconds: skew,
        });
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function serverIssues(rows) {
    const L = OPS_LIMITS;
    const out = [];
    for (const r of rows) {
        if (!r.reportedAt) {
            out.push(issue('servers', 'warning', 'no_report', r.name));
            continue;
        }
        if (r.reportAgeHours > L.serverReportHours) {
            out.push(issue('servers', 'warning', 'report_old', r.name, { hours: Math.round(r.reportAgeHours) }));
        }
        for (const code of r.healthIssues) {
            if (!SERVER_HEALTH[code]) continue;
            const params = code === 'low_disk'
                ? { drives: r.volumes.filter((v) => v.freePct < 10).map((v) => `${v.drive ?? '?'} ${v.freePct}%`).join(', ') }
                : {};
            out.push(issue('servers', SERVER_HEALTH[code], code, r.name, params));
        }
        if (r.stoppedServices.length) {
            out.push(issue('servers', 'warning', 'services_stopped', r.name, {
                services: r.stoppedServices.map((x) => x.displayName || x.name).slice(0, 6).join(', '),
                count: r.stoppedServices.length,
            }));
        }
        if (r.clockSkewSeconds !== null && Math.abs(r.clockSkewSeconds) > L.clockSkewSeconds) {
            out.push(issue('servers',
                Math.abs(r.clockSkewSeconds) > L.clockSkewCriticalSeconds ? 'critical' : 'warning',
                'clock_skew', r.name, { seconds: r.clockSkewSeconds }));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 2. backups (Veeam)
// ---------------------------------------------------------------------------

function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

// How often a job normally runs, from the gaps between its recent starts.
function jobIntervalMs(job) {
    const starts = (job.sessions ?? [])
        .map((x) => Date.parse(x.start))
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    const gaps = [];
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i - 1] - starts[i]);
    const measured = gaps.filter((g) => g > 3600000);
    if (measured.length >= 2) return median(measured);
    // Too few runs to measure yet: go by the job's name.
    if (/monthly/i.test(job.name)) return 31 * DAY;
    if (/full|weekly/i.test(job.name)) return 7 * DAY;
    return DAY;
}

export function backupSummary(snap) {
    const data = snap?.data;
    if (!data) return null;
    const jobs = (data.jobs ?? []).map((j) => {
        const sessions = j.sessions ?? [];
        const lastSuccess = sessions.find((x) => /success|warning/i.test(x.result || ''))?.end ?? null;
        const interval = jobIntervalMs(j);
        // Late = no good run within 1.5 normal intervals + 12 h slack
        // (daily jobs skip the weekend; a weekly full is allowed a day late).
        const allowedMs = interval ? interval * 1.5 + 12 * 3600000 : null;
        const late = Boolean(j.enabled && lastSuccess && allowedMs && Date.now() - Date.parse(lastSuccess) > allowedMs);
        return {
            name: j.name,
            type: j.type ?? null,
            enabled: j.enabled !== false,
            lastResult: j.lastResult ?? sessions[0]?.result ?? null,
            lastStart: sessions[0]?.start ?? null,
            lastEnd: sessions[0]?.end ?? null,
            lastSuccess,
            intervalHours: interval ? Math.round(interval / 3600000) : null,
            late,
            sizeGb: j.sizeGb ?? null,
            sessions: sessions.slice(0, 10),
        };
    });
    const repositories = (data.repositories ?? []).map((r) => ({
        ...r,
        freePct: r.totalGb > 0 ? Math.round((r.freeGb / r.totalGb) * 100) : null,
    }));
    return { server: data.server ?? null, reportedAt: snap.fetchedAt, jobs, repositories };
}

export function backupIssues(summary) {
    const L = OPS_LIMITS;
    if (!summary) return [issue('backup', 'warning', 'no_data', 'veeam')];
    const out = [];
    const age = ageHours(new Date(summary.reportedAt).toISOString());
    if (age > L.backupDataHours) out.push(issue('backup', 'warning', 'data_old', summary.server || 'veeam', { hours: Math.round(age) }));
    for (const j of summary.jobs) {
        if (!j.enabled) continue;
        if (!j.lastStart || /^none$/i.test(j.lastResult || '') && !j.lastSuccess) {
            out.push(issue('backup', 'critical', 'job_never', j.name));
        } else if (/failed/i.test(j.lastResult || '')) {
            out.push(issue('backup', 'critical', 'job_failed', j.name, { at: j.lastStart }));
        } else if (j.late) {
            out.push(issue('backup', 'critical', 'job_late', j.name, { lastSuccess: j.lastSuccess }));
        } else if (/warning/i.test(j.lastResult || '')) {
            out.push(issue('backup', 'warning', 'job_warning', j.name, { at: j.lastStart }));
        }
    }
    for (const r of summary.repositories) {
        if (r.freePct === null || r.freePct >= L.repoLowPct) continue;
        out.push(issue('backup', r.freePct < L.repoCriticalPct ? 'critical' : 'warning', 'repo_low', r.name,
            { freePct: r.freePct, freeGb: Math.round(r.freeGb) }));
    }
    return out;
}

// ---------------------------------------------------------------------------
// 3. AD + DNS hygiene
// ---------------------------------------------------------------------------

function hygieneSummaries(snaps) {
    return Object.entries(snaps)
        .filter(([key, v]) => key.startsWith('hygiene_') && v?.data)
        .map(([, v]) => {
            const h = v.data;
            const dcIps = new Set((h.dcs ?? []).flatMap((d) => [...(d.ips ?? []), d.ip]).filter(Boolean));
            const apex = h.dns?.apex ?? [];
            return {
                ...h,
                reportedAt: v.fetchedAt,
                apexTotal: apex.length,
                apexJunk: apex.filter((a) => !dcIps.has(a.ip)),
            };
        })
        .sort((a, b) => String(a.domain).localeCompare(String(b.domain)));
}

function hygieneIssues(list) {
    const L = OPS_LIMITS;
    if (!list.length) return [issue('ad', 'warning', 'no_data', 'ad')];
    const out = [];
    for (const h of list) {
        const d = h.domain;
        const age = ageHours(new Date(h.reportedAt).toISOString());
        if (age > L.hygieneDataHours) out.push(issue('ad', 'warning', 'data_old', d, { hours: Math.round(age) }));
        if (h.apexJunk.length) out.push(issue('ad', 'warning', 'apex_junk', d, { count: h.apexJunk.length, total: h.apexTotal }));
        if (h.dns && /nonsecure/i.test(h.dns.dynamicUpdate || '')) out.push(issue('ad', 'warning', 'dns_insecure', d, { zone: h.dns.zone }));
        if (h.dns && (!h.dns.aging || !h.dns.scavenging)) out.push(issue('ad', 'warning', 'dns_no_scavenging', d, { zone: h.dns.zone }));
        const staleC = h.computers?.staleCount || (h.computers?.staleEnabled?.length ?? 0);
        if (staleC) out.push(issue('ad', 'warning', 'stale_computers', d, { count: staleC }));
        const staleU = h.users?.staleCount || (h.users?.staleEnabled?.length ?? 0);
        if (staleU) out.push(issue('ad', 'warning', 'stale_users', d, { count: staleU }));
        const oldPw = h.users?.oldPwCount || (h.users?.oldPasswords?.length ?? 0);
        if (oldPw) out.push(issue('ad', 'warning', 'old_passwords', d, { count: oldPw }));
        const admins = (h.admins ?? []).find((g) => /domain admins/i.test(g.group));
        if (admins && admins.members?.length > 5) out.push(issue('ad', 'warning', 'admins_many', d, { count: admins.members.length }));
    }
    return out;
}

// ---------------------------------------------------------------------------
// 4. certificates + licenses
// ---------------------------------------------------------------------------

// IT_CERT_TARGETS="host[:port][,host...]" overrides. Internal hosts use their
// own CA / self-signed certificates, so only expiry is judged, not trust.
const DEFAULT_CERT_TARGETS = 'app.petralu.net,petralu.com,petra-exchange.petralu.local';

export function certTargets() {
    return String(process.env.IT_CERT_TARGETS || DEFAULT_CERT_TARGETS)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
            const [host, port] = x.split(':');
            return { host, port: Number(port) || 443 };
        });
}

export function checkCert({ host, port }) {
    return new Promise((resolve) => {
        let finished = false;
        const done = (v) => {
            if (finished) return;
            finished = true;
            resolve({ host, port, checkedAt: new Date().toISOString(), ...v });
        };
        const sock = tls.connect({
            host,
            port,
            servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host,
            rejectUnauthorized: false,
            timeout: 8000,
        }, () => {
            const c = sock.getPeerCertificate();
            const validTo = c?.valid_to ? new Date(c.valid_to).toISOString() : null;
            done({
                subject: c?.subject?.CN ?? null,
                issuer: c?.issuer?.CN ?? c?.issuer?.O ?? null,
                validFrom: c?.valid_from ? new Date(c.valid_from).toISOString() : null,
                validTo,
                daysLeft: validTo ? Math.floor((Date.parse(validTo) - Date.now()) / DAY) : null,
                trusted: sock.authorized,
                trustError: sock.authorizationError ? String(sock.authorizationError) : null,
                error: null,
            });
            sock.end();
        });
        sock.on('timeout', () => { done({ error: 'timeout' }); sock.destroy(); });
        sock.on('error', (err) => done({ error: err.code || err.message }));
    });
}

export async function refreshCerts() {
    const items = await Promise.all(certTargets().map(checkCert));
    await saveSnapshot('certs', { items });
    return items;
}

function certIssues(snap) {
    const L = OPS_LIMITS;
    const out = [];
    for (const c of snap?.data?.items ?? []) {
        const target = `${c.host}:${c.port}`;
        // Days left are recounted from validTo, so a 6-hour-old check stays right.
        const days = c.validTo ? Math.floor((Date.parse(c.validTo) - Date.now()) / DAY) : null;
        if (c.error) out.push(issue('certs', 'warning', 'cert_error', target, { error: c.error }));
        else if (days !== null && days < 0) out.push(issue('certs', 'critical', 'cert_expired', target, { validTo: c.validTo }));
        else if (days !== null && days <= L.certWarnDays) {
            out.push(issue('certs', days <= L.certCriticalDays ? 'critical' : 'warning', 'cert_expiring', target, { days, validTo: c.validTo }));
        }
    }
    return out;
}

async function licenseExpiries() {
    const rows = await ItLicense.findAll({
        where: { status: 'active' },
        attributes: ['id', 'productName', 'vendor', 'category', 'expiryDate'],
        raw: true,
    });
    return rows
        .map((r) => ({ ...r, daysLeft: Math.floor((Date.parse(r.expiryDate) - Date.now()) / DAY) }))
        .sort((a, b) => a.daysLeft - b.daysLeft);
}

function licenseIssues(rows) {
    const out = [];
    for (const r of rows) {
        // Not alerted: services/itLicenseMonitor.js already sends reminders.
        if (r.daysLeft < 0) out.push(issue('expiry', 'warning', 'license_expired', r.productName, { days: -r.daysLeft, date: r.expiryDate }));
        else if (r.daysLeft <= OPS_LIMITS.licenseWarnDays) out.push(issue('expiry', 'warning', 'license_expiring', r.productName, { days: r.daysLeft, date: r.expiryDate }));
    }
    return out;
}

// ---------------------------------------------------------------------------
// everything together
// ---------------------------------------------------------------------------

export async function buildOps() {
    const snaps = await loadSnapshots();
    const devices = await buildDeviceList(snaps);
    const servers = serverRows(devices);
    const backup = backupSummary(snaps.backup);
    const hygiene = hygieneSummaries(snaps);
    const certs = (snaps.certs?.data?.items ?? []).map((c) => ({
        ...c,
        daysLeft: c.validTo ? Math.floor((Date.parse(c.validTo) - Date.now()) / DAY) : null,
    }));
    const licenses = await licenseExpiries();
    const issues = [
        ...serverIssues(servers),
        ...backupIssues(backup),
        ...hygieneIssues(hygiene),
        ...certIssues(snaps.certs),
        ...licenseIssues(licenses),
    ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
    return {
        servers,
        backup,
        hygiene,
        certs,
        certsCheckedAt: snaps.certs?.fetchedAt ?? null,
        licenses,
        issues,
        counts: {
            critical: issues.filter((i) => i.severity === 'critical').length,
            warning: issues.filter((i) => i.severity === 'warning').length,
            byArea: issues.reduce((acc, i) => ({ ...acc, [i.area]: (acc[i.area] ?? 0) + 1 }), {}),
        },
        limits: OPS_LIMITS,
    };
}

// ---------------------------------------------------------------------------
// monitor: certificate checks + alerts for new critical issues
// ---------------------------------------------------------------------------

const AREA_TITLE = { servers: 'Server', backup: 'Backup', ad: 'AD/DNS', certs: 'Certificate', expiry: 'Expiry' };

function describe(i) {
    const p = i.params;
    switch (i.code) {
        case 'av_none': return `${i.target}: no antivirus`;
        case 'av_off': return `${i.target}: antivirus is off`;
        case 'low_disk': return `${i.target}: low disk space (${p.drives})`;
        case 'clock_skew': return `${i.target}: clock is ${p.seconds}s off`;
        case 'job_never': return `${i.target}: has never run`;
        case 'job_failed': return `${i.target}: last run failed`;
        case 'job_late': return `${i.target}: no good backup since ${String(p.lastSuccess).slice(0, 10)}`;
        case 'repo_low': return `${i.target}: only ${p.freePct}% free (${p.freeGb} GB)`;
        case 'cert_expired': return `${i.target}: certificate expired`;
        case 'cert_expiring': return `${i.target}: certificate expires in ${p.days} days`;
        default: return `${i.target}: ${i.code}`;
    }
}

async function checkAlerts() {
    const ops = await buildOps();
    const now = new Set(ops.issues.filter((i) => i.severity === 'critical').map((i) => i.key));
    const prevRow = await NetworkSnapshot.findByPk('ops_alerted');
    let prev = null;
    try { prev = prevRow?.data ? JSON.parse(prevRow.data) : null; } catch { prev = null; }
    await saveSnapshot('ops_alerted', { keys: [...now] });
    // First run: remember what is already wrong without a burst of alerts --
    // the page shows it.
    if (!prev) return;
    const before = new Set(prev.keys ?? []);
    const raised = ops.issues.filter((i) => now.has(i.key) && !before.has(i.key));
    const cleared = [...before].filter((k) => !now.has(k));
    for (const i of raised.slice(0, 5)) {
        pushAlert(`🔴 ${AREA_TITLE[i.area] ?? 'IT'} problem`, `${describe(i)}.`, '/admin/it-ops');
    }
    if (raised.length > 5) pushAlert('🔴 IT problems', `${raised.length - 5} more new problems -- see IT Servers & Backups.`, '/admin/it-ops');
    if (cleared.length) {
        const names = cleared.slice(0, 4).map((k) => k.split(':').slice(2).join(':')).join(', ');
        pushAlert('🟢 IT problem fixed', `${cleared.length} fixed: ${names}${cleared.length > 4 ? '…' : ''}.`, '/admin/it-ops');
    }
}

export function startItOpsMonitor() {
    console.log('🖥️ IT ops monitor started (certificates every 6 h, alerts every 15 min)');
    const certs = () => refreshCerts().catch((err) => console.error('❌ Certificate check failed:', err));
    const alerts = () => checkAlerts().catch((err) => console.error('❌ IT ops alert check failed:', err));
    setTimeout(() => { certs().then(alerts); }, 60 * 1000);
    setInterval(certs, CERT_INTERVAL_MS);
    setInterval(alerts, ALERT_INTERVAL_MS);
}
