// backend/services/softwareInventory.js
// Installed-software inventory for the IT software page (2026-11-25): every
// PC/server report (Send-PcReport.ps1 "software", machine-wide Uninstall
// registry entries) grouped by program, plus matching against the software
// library. Read-only.
import { loadSnapshots } from './networkInventory.js';

// Runtimes, drivers and other plumbing -- hidden by default on the page.
const SYSTEM_RE = /visual c\+\+|redistributable|\.net (framework|runtime|desktop)|windows desktop runtime|asp\.net|runtime\b|\bdriver|intel\(r\)|realtek|nvidia|amd (software|chipset)|webview2|windows sdk|language pack|\bmui\b|update for|security update|hotfix|vcredist|directx|microsoft (update health|policy platform)|windows pc health|teams machine-wide|office 16 click-to-run|click-to-run (extensibility|licensing|localization)|setup|bonjour|java auto updater|^kb\d+/i;

// "7-Zip 19.00 (x64)" and "7-Zip 23.01 (x64 edition)" -> "7-Zip"
export function programKey(name) {
    return String(name ?? '')
        .replace(/\((x64|x86|64-bit|32-bit)[^)]*\)/gi, '')
        .replace(/\b(x64|x86|64-bit|32-bit)\b/gi, '')
        .replace(/\s+v?\d+(\.\d+)+[a-z]?\b.*$/i, '')
        .replace(/\s+-\s*$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim() || String(name ?? '').trim();
}

// Compares dotted versions numerically: -1 / 0 / 1 (null when unknown).
export function compareVersions(a, b) {
    if (!a || !b) return null;
    const pa = String(a).split(/[.\-_ ]/).map((x) => Number.parseInt(x, 10));
    const pb = String(b).split(/[.\-_ ]/).map((x) => Number.parseInt(x, 10));
    if (pa.some(Number.isNaN) && pb.some(Number.isNaN)) return null;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

export function matcher(pattern) {
    const p = String(pattern ?? '').trim();
    if (!p) return () => false;
    const rx = /^\/(.+)\/([a-z]*)$/i.exec(p);
    if (rx) {
        try {
            const re = new RegExp(rx[1], rx[2].includes('i') ? rx[2] : `${rx[2]}i`);
            return (name) => re.test(name);
        } catch {
            return () => false;
        }
    }
    const low = p.toLowerCase();
    return (name) => String(name).toLowerCase().includes(low);
}

// One row per machine that sent a software list.
export async function loadInstalled(snapshots) {
    const snaps = snapshots ?? await loadSnapshots();
    const machines = [];
    let reporting = 0;
    for (const [key, snap] of Object.entries(snaps)) {
        if (!key.startsWith('pc:') || !snap?.data) continue;
        reporting += 1;
        const list = snap.data.software;
        if (!Array.isArray(list)) continue;
        machines.push({
            name: snap.data.computerName,
            user: snap.data.user ?? null,
            os: snap.data.os?.caption ?? null,
            reportedAt: snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : null,
            software: list,
        });
    }
    return { reporting, machines };
}

export function groupInstalled(machines) {
    const groups = new Map();
    for (const m of machines) {
        for (const sw of m.software) {
            const key = programKey(sw.name).toLowerCase();
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    name: programKey(sw.name),
                    publisher: sw.publisher ?? null,
                    system: SYSTEM_RE.test(sw.name),
                    names: new Set(),
                    versions: new Map(),
                    pcs: new Set(),
                });
            }
            const g = groups.get(key);
            g.names.add(sw.name);
            g.pcs.add(m.name);
            const v = sw.version || '?';
            if (!g.versions.has(v)) g.versions.set(v, new Set());
            g.versions.get(v).add(m.name);
        }
    }
    return [...groups.values()]
        .map((g) => ({
            key: g.key,
            name: g.name,
            publisher: g.publisher,
            system: g.system,
            names: [...g.names].slice(0, 10),
            pcCount: g.pcs.size,
            versions: [...g.versions.entries()]
                .map(([version, pcs]) => ({ version, pcs: [...pcs].sort() }))
                .sort((a, b) => -(compareVersions(a.version, b.version) ?? 0)),
        }))
        .sort((a, b) => b.pcCount - a.pcCount || a.name.localeCompare(b.name));
}

// Library item -> where it is installed, at which version, how many are
// older than the library's version, and licence seat use.
export function matchLibraryItem(item, machines, license) {
    const test = matcher(item.matchPattern);
    const pcs = [];
    for (const m of machines) {
        const hit = m.software.filter((sw) => test(sw.name));
        if (!hit.length) continue;
        // Newest matching version on that PC
        const best = hit.reduce((acc, sw) => (compareVersions(sw.version, acc.version) === 1 ? sw : acc), hit[0]);
        pcs.push({
            pc: m.name,
            user: m.user,
            version: best.version || null,
            outdated: item.version ? compareVersions(best.version, item.version) === -1 : false,
        });
    }
    pcs.sort((a, b) => a.pc.localeCompare(b.pc));
    return {
        installedCount: pcs.length,
        outdatedCount: pcs.filter((p) => p.outdated).length,
        pcs,
        seats: license?.seats ?? null,
        overSeats: license?.seats ? Math.max(0, pcs.length - license.seats) : 0,
    };
}
