// backend/services/networkInventory.js
// Builds the IT network page's device list at request time by merging the
// latest snapshots (models/Network.js):
//
//   Meraki clients  -- key = MAC (what's actually on the wire, last 24 h)
//   DHCP leases     -- key = MAC (from DC3's scheduled push)
//   DHCP reservations
//   AD computers    -- matched to a MAC row by host name, then by IP;
//                      otherwise their own "ad:<NAME>" row (never seen)
//   monitor targets -- attached to the row with the same IP
//   device notes    -- label / owner / notes typed by IT
import { NetworkSnapshot, NetworkMonitorTarget, NetworkDeviceNote } from '../models/Network.js';

// "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "aabbccddeeff" -> "aa:bb:cc:dd:ee:ff"
export function normalizeMac(value) {
    if (!value) return null;
    const hex = String(value).toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) return null;
    return hex.match(/.{2}/g).join(':');
}

// Meraki's client firstSeen/lastSeen are epoch seconds; DHCP/AD send ISO.
export function toIso(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "TECHNICAL-05.petralu.local" -> "technical-05"
function shortName(value) {
    if (!value) return null;
    const s = String(value).trim().toLowerCase().split('.')[0];
    return s || null;
}

export async function loadSnapshots() {
    const rows = await NetworkSnapshot.findAll();
    const out = {};
    for (const r of rows) {
        let data = null;
        try { data = r.data ? JSON.parse(r.data) : null; } catch { data = null; }
        out[r.source] = { data, fetchedAt: r.fetchedAt, error: r.error, errorAt: r.errorAt };
    }
    return out;
}

function emptyRow(key) {
    return {
        key,
        mac: key.includes(':') && !key.startsWith('ad:') && !key.startsWith('ip:') ? key : null,
        name: null,
        ip: null,
        online: false,
        lastSeen: null,
        firstSeen: null,
        manufacturer: null,
        os: null,
        deviceType: null,
        site: null,
        vlan: null,
        connection: null, // 'wired' | 'wireless'
        connectedTo: null, // switch / AP name
        switchport: null,
        ssid: null,
        user: null,
        usage: null,
        sources: [],
        meraki: null,
        dhcp: null,
        reservation: null,
        ad: null,
        monitor: null,
        scan: null, // { alive, rttMs, pingBlocked, name } from the LAN scan
        pc: null, // the PC's own report (activation, Office, user, hardware)
        activation: null, // summarizeActivation(pc)
        health: null, // summarizeHealth(pc): antivirus + PC health issues
        lastLogon: null, // { user, domain, time, dc } from DC Kerberos events
        label: null,
        owner: null,
        notes: null,
        windows: false,
    };
}

export async function buildDeviceList(snapshots) {
    const snaps = snapshots ?? await loadSnapshots();
    const rows = new Map();
    const get = (key) => {
        if (!rows.has(key)) rows.set(key, emptyRow(key));
        return rows.get(key);
    };

    // --- Meraki clients (newest sighting wins when a MAC shows up in more
    // than one network)
    const clients = snaps.meraki_clients?.data ?? [];
    for (const c of clients) {
        const mac = normalizeMac(c.mac);
        if (!mac) continue;
        const row = get(mac);
        const lastSeen = toIso(c.lastSeen);
        if (row.meraki && row.lastSeen && lastSeen && row.lastSeen > lastSeen) continue;
        if (!row.sources.includes('meraki')) row.sources.push('meraki');
        row.meraki = { id: c.id, networkId: c.networkId, description: c.description, notes: c.notes };
        row.ip = c.ip || row.ip;
        row.online = c.status === 'Online';
        row.lastSeen = lastSeen;
        row.firstSeen = toIso(c.firstSeen);
        row.manufacturer = c.manufacturer;
        row.os = c.os || row.os;
        row.deviceType = c.deviceTypePrediction;
        row.site = c.networkName;
        row.vlan = c.vlan ?? null;
        row.connection = c.recentDeviceConnection
            ? String(c.recentDeviceConnection).toLowerCase() : (c.ssid ? 'wireless' : null);
        row.connectedTo = c.recentDeviceName;
        row.switchport = c.switchport;
        row.ssid = c.ssid;
        row.user = c.user;
        row.usage = c.usage;
        row.name = row.name || c.description || null;
    }

    // --- LAN scan from the server (services/lanScan.js): online now + IP/MAC.
    // Hosts on other subnets have no MAC (ARP doesn't cross routers) and get
    // an "ip:<addr>" row.
    const scan = snaps.lan_scan?.data;
    for (const h of scan?.hosts ?? []) {
        const mac = normalizeMac(h.mac);
        const row = get(mac || `ip:${h.ip}`);
        if (!row.sources.includes('scan')) row.sources.push('scan');
        row.scan = { alive: h.alive, rttMs: h.rttMs ?? null, pingBlocked: !!h.pingBlocked, name: h.name ?? null };
        if (h.alive) {
            row.online = true;
            row.ip = h.ip;
        } else {
            row.ip = row.ip || h.ip;
        }
        if (h.lastSeen && (!row.lastSeen || h.lastSeen > row.lastSeen)) row.lastSeen = h.lastSeen;
        if (!row.name && h.name) row.name = h.name.split('.')[0].toUpperCase();
    }

    // --- DHCP leases + reservations
    const dhcp = snaps.dhcp?.data ?? {};
    for (const l of dhcp.leases ?? []) {
        const mac = normalizeMac(l.mac);
        if (!mac) continue;
        const row = get(mac);
        if (!row.sources.includes('dhcp')) row.sources.push('dhcp');
        row.dhcp = {
            ip: l.ip,
            hostName: l.hostName ?? null,
            state: l.addressState ?? null,
            expires: toIso(l.leaseExpiry),
            scopeId: l.scopeId ?? null,
        };
        row.ip = row.ip || l.ip;
        if (l.hostName) row.name = row.name || shortName(l.hostName)?.toUpperCase();
    }
    for (const r of dhcp.reservations ?? []) {
        const mac = normalizeMac(r.mac);
        if (!mac) continue;
        const row = get(mac);
        if (!row.sources.includes('dhcp')) row.sources.push('dhcp');
        row.reservation = { ip: r.ip, name: r.name ?? null, description: r.description ?? null };
        row.ip = row.ip || r.ip;
        row.name = row.name || r.name || null;
    }

    // --- AD computers
    const byName = new Map();
    const byIp = new Map();
    for (const row of rows.values()) {
        for (const n of [row.dhcp?.hostName, row.meraki?.description, row.reservation?.name]) {
            const s = shortName(n);
            if (s && !byName.has(s)) byName.set(s, row);
        }
        if (row.ip && !byIp.has(row.ip)) byIp.set(row.ip, row);
    }
    // One AD snapshot per domain: 'ad' = petralu.local (DC3), 'ad_<NETBIOS>'
    // = other domains, e.g. 'ad_PETRATH' from PETRATH-DC01 (2026-11-25).
    const computers = [];
    for (const [source, snap] of Object.entries(snaps)) {
        if (source !== 'ad' && !source.startsWith('ad_')) continue;
        const domain = String(snap.data?.domain || (source === 'ad' ? 'PETRALU' : source.slice(3))).toUpperCase();
        for (const c of snap.data?.computers ?? []) computers.push({ ...c, domain });
    }
    for (const c of computers) {
        const s = shortName(c.name);
        if (!s) continue;
        // A row takes at most one AD computer. The IP match is the weaker
        // one (AD's IPv4 comes from DNS and can be stale), so a second AD
        // record pointing at an already-matched device gets its own row
        // instead of overwriting the first.
        const free = (r) => (r && !r.ad ? r : null);
        // IP match only for rows that don't name themselves: a phone with its
        // own DHCP host name that now holds a PC's old (DNS) IP is not that PC.
        // ...and only for accounts that signed in recently: a computer gone
        // for years keeps its old DNS record, and that IP now belongs to
        // another machine (PETRA-PRINTERS, last logon 2021, pointed at
        // PETRA-EXCHANGE's IP).
        const fresh = Boolean(c.lastLogon) && Date.now() - Date.parse(c.lastLogon) < STALE_AD_DAYS * 86400000;
        const ipRow = c.ipv4 && fresh ? byIp.get(c.ipv4) : null;
        const ipMatch = ipRow && !ipRow.dhcp?.hostName && !ipRow.reservation?.name ? ipRow : null;
        const ownKey = c.domain === 'PETRALU' ? `ad:${s.toUpperCase()}` : `ad:${c.domain}\\${s.toUpperCase()}`;
        const row = free(byName.get(s)) || free(ipMatch) || get(ownKey);
        if (!row.sources.includes('ad')) row.sources.push('ad');
        row.ad = {
            name: c.name,
            domain: c.domain,
            dnsHostName: c.dnsHostName ?? null,
            os: c.os ?? null,
            osVersion: c.osVersion ?? null,
            enabled: c.enabled !== false,
            lastLogon: toIso(c.lastLogon),
            description: c.description ?? null,
            ou: c.ou ?? null,
            ipv4: c.ipv4 ?? null,
        };
        row.name = c.name;
        row.os = c.os || row.os;
        row.ip = row.ip || (fresh ? c.ipv4 : null) || null;
        row.windows = true;
    }

    // --- each PC's own report (routes/network.js POST /report): activation,
    // installed Office, logged-on user. Matched by computer name, then by
    // any of its MACs; a PC never seen otherwise gets its "ad:<NAME>" row.
    const rowsByName = new Map();
    for (const row of rows.values()) {
        for (const n of [row.ad?.name, row.dhcp?.hostName, row.reservation?.name, row.scan?.name, row.name]) {
            const s = shortName(n);
            if (s && !rowsByName.has(s)) rowsByName.set(s, row);
        }
    }
    for (const [source, snap] of Object.entries(snaps)) {
        if (!source.startsWith('pc:') || !snap.data) continue;
        const p = snap.data;
        const s = shortName(p.computerName);
        let row = rowsByName.get(s);
        if (!row) {
            const mac = (p.nics ?? []).map((n) => n.mac).find((m) => m && rows.has(m));
            row = mac ? rows.get(mac) : get(`ad:${String(p.computerName).toUpperCase()}`);
        }
        if (!row.sources.includes('pc')) row.sources.push('pc');
        row.pc = { ...p, reportedAt: snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : null };
        row.activation = summarizeActivation(p);
        row.health = summarizeHealth(p, row.pc.reportedAt);
        row.win11 = win11Readiness(p);
        row.name = row.name || p.computerName;
        row.windows = true;
    }

    // --- last domain user per IP: newest across every DC's logons snapshot.
    // Kerberos TGT events say who last authenticated FROM that IP -- usually
    // the person at the PC, but a run-as / share login also counts, so the
    // page labels it "last logon", not "logged in now".
    const lastLogonByIp = new Map();
    for (const [source, snap] of Object.entries(snaps)) {
        if (!source.startsWith('logons_')) continue;
        for (const l of snap.data?.items ?? []) {
            const prev = lastLogonByIp.get(l.ip);
            if (!prev || String(l.time) > String(prev.time)) {
                lastLogonByIp.set(l.ip, { user: l.user, domain: l.domain, time: toIso(l.time), dc: snap.data.dc });
            }
        }
    }
    for (const row of rows.values()) {
        // Only rows whose IP is current (Meraki or a DHCP lease) -- an AD-only
        // row's IP comes from DNS and may belong to another PC by now.
        if (!row.ip || (!row.meraki && !row.dhcp && !row.reservation && !row.scan?.alive)) continue;
        const l = lastLogonByIp.get(row.ip);
        if (l) row.lastLogon = l;
    }

    // --- monitor targets, matched by IP or host name
    const targets = await NetworkMonitorTarget.findAll({ attributes: ['id', 'name', 'host', 'status', 'lastRttMs', 'lastCheckedAt'] });
    for (const row of rows.values()) {
        const t = targets.find((x) => x.host === row.ip
            || (row.name && shortName(x.host) === shortName(row.name)));
        if (t) row.monitor = { id: t.id, name: t.name, status: t.status, rttMs: t.lastRttMs, checkedAt: t.lastCheckedAt };
    }

    // --- IT's own notes
    const notes = await NetworkDeviceNote.findAll();
    const notesByKey = new Map(notes.map((n) => [n.deviceKey, n]));
    // Known Windows names (AD + PC reports), so a PC's second NIC / Wi-Fi row
    // that only has a DHCP host name is still recognised as that PC.
    const pcNames = new Set();
    for (const c of computers) if (shortName(c.name)) pcNames.add(shortName(c.name));
    for (const row of rows.values()) if (row.pc?.computerName) pcNames.add(shortName(row.pc.computerName));
    for (const row of rows.values()) {
        const n = notesByKey.get(row.key);
        if (n) {
            row.label = n.label;
            row.owner = n.owner;
            row.notes = n.notes;
        }
        if (!row.windows && row.os && /windows/i.test(row.os)) row.windows = true;
        row.site = row.site || siteOf(row);
        // Windows still getting security updates? (PC report first, else AD)
        row.osSupported = row.pc?.os?.caption
            ? osSupported(row.pc.os.caption, row.pc.os.build || row.pc.os.version)
            : row.ad ? osSupported(row.ad.os, row.ad.osVersion) : null;
        classifyDevice(row, pcNames);
    }

    return [...rows.values()].sort((a, b) =>
        Number(b.online) - Number(a.online)
        || ipSortKey(a.ip) - ipSortKey(b.ip)
        || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

// ---------------------------------------------------------------------------
// Device category from what we have without Meraki: Windows/AD data, the DHCP
// host name and the MAC. Phones name themselves after the model
// ("Galaxy-A21s", "TECNO-SPARK-8T", "iPhone") and often the owner
// ("A55-alkhas-b-Ayman" = "A55 belongs to Ayman", "Adham-s-S21"); on Wi-Fi
// they use a private (randomised) MAC -- the "locally administered" bit, 2nd
// hex digit 2/6/A/E. Phones on Petra-Guest are NATed by Aruba and never reach
// DC DHCP, so only phones on the office network show up here.
// ---------------------------------------------------------------------------

const PHONE_BRANDS = [
    [/ipad/i, 'Apple', 'tablet'],
    [/iphone/i, 'Apple', 'phone'],
    [/galaxy-tab|^sm-t/i, 'Samsung', 'tablet'],
    [/galaxy|samsung|^sm-|z-?fold|z-?flip|^[as]\d{2}[a-z]?(?:-|$)|(?:^|-)s2\d(?:-|$)/i, 'Samsung', 'phone'],
    [/huawei/i, 'Huawei', 'phone'],
    [/honor/i, 'Honor', 'phone'],
    [/redmi|xiaomi|poco|^mi-/i, 'Xiaomi', 'phone'],
    [/oppo/i, 'OPPO', 'phone'],
    [/vivo/i, 'vivo', 'phone'],
    [/realme/i, 'realme', 'phone'],
    [/tecno/i, 'TECNO', 'phone'],
    [/infinix/i, 'Infinix', 'phone'],
    [/itel/i, 'itel', 'phone'],
    [/pixel/i, 'Google', 'phone'],
    [/oneplus/i, 'OnePlus', 'phone'],
    [/nokia/i, 'Nokia', 'phone'],
    [/moto/i, 'Motorola', 'phone'],
    [/android/i, null, 'phone'],
];

export function isPrivateMac(mac) {
    const hex = String(mac ?? '').replace(/[^0-9a-f]/gi, '');
    return hex.length === 12 && /^.[26ae]/i.test(hex);
}

// Site = which network the device is on, from its IP; a device with no IP
// (AD-only, never seen) falls back to its AD domain. NETWORK_SITES overrides
// the map: "192.168.20.0/24=PETRALU,192.168.10.0/24=PetraTH".
const DOMAIN_SITES = { PETRALU: 'PETRALU', PETRATH: 'PetraTH' };
let siteRanges = null;
function parseSites() {
    const spec = process.env.NETWORK_SITES || '192.168.20.0/24=PETRALU,192.168.10.0/24=PetraTH';
    return spec.split(',').map((part) => {
        const [cidr, name] = part.split('=').map((x) => x?.trim());
        const [base, bits] = (cidr || '').split('/');
        const n = ipToInt(base);
        const b = Number(bits);
        if (n === null || !(b >= 0 && b <= 32) || !name) return null;
        const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
        return { net: (n & mask) >>> 0, mask, name };
    }).filter(Boolean);
}
function ipToInt(ip) {
    const m = String(ip ?? '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some((x) => x > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
export function siteOf(row) {
    siteRanges ??= parseSites();
    const n = ipToInt(row.ip);
    if (n !== null) {
        const hit = siteRanges.find((r) => ((n & r.mask) >>> 0) === r.net);
        if (hit) return hit.name;
    }
    const d = row.ad?.domain;
    return d ? DOMAIN_SITES[d] || d : null;
}

function hostOf(row) {
    const n = row.dhcp?.hostName || row.reservation?.name || row.scan?.name || row.meraki?.description || row.name;
    return n ? String(n).split('.')[0].trim() : '';
}

// "A55-alkhas-b-Ayman" -> { owner: "Ayman", model: "A55" }
// "Adham-s-S21"        -> { owner: "Adham", model: "S21" }
// "HUAWEI_Y8s-8b5df9038ed1ee" -> { model: "HUAWEI Y8s" }
function parsePhoneName(host) {
    let owner = null;
    let model = host;
    let m = host.match(/^(.*?)-?alkhas-b-(.+)$/i);
    if (m) {
        model = m[1];
        owner = m[2];
    } else if ((m = host.match(/^([A-Za-z]+)-s-(.+)$/))) {
        owner = m[1];
        model = m[2];
    }
    model = model
        .replace(/[-_][0-9a-f]{4,}$/i, '') // trailing id: -a3c9, -8b5df9038ed1ee
        .replace(/[-_]+/g, ' ')
        .trim();
    if (/^iphone$/i.test(model)) model = 'iPhone';
    return { owner: owner ? owner.replace(/[-_]+/g, ' ').trim() : null, model: model || null };
}

function classifyDevice(row, pcNames) {
    const host = hostOf(row);
    const mac = row.mac || (row.key && /^[0-9a-f:]{17}$/.test(row.key) ? row.key : null);
    row.privateMac = isPrivateMac(mac);
    row.category = null;
    row.mobile = null;

    if (row.windows || row.ad || row.pc) {
        row.category = /server/i.test(row.ad?.os || row.os || '') ? 'server' : 'pc';
        return;
    }
    if (host && pcNames?.has(shortName(host))) {
        row.category = 'pc';
        return;
    }
    if (/^ipconflict/i.test(host)) return; // DHCP placeholder for a declined address
    if (/macbook|imac|^apple[- ]pc/i.test(host)) {
        row.category = 'pc';
        return;
    }
    if (/^00:15:5d/i.test(mac ?? '')) {
        row.category = 'vm';
        return;
    }
    if (/^(cam|nvr|dvr)\b|^cam[-_ ]/i.test(host)) {
        row.category = 'camera';
        return;
    }
    if (/canon|epson|brother|ricoh|kyocera|xerox|printer|^npi[0-9a-f]{6}|^hp[0-9a-f]{6}/i.test(host)) {
        row.category = 'printer';
        return;
    }
    if (/^(ap-?\d|switch|sw-|ilo|router|mx\d|ms\d|mr\d)/i.test(host)) {
        row.category = 'network';
        return;
    }
    // Test the brand on the whole name and on the model part, so
    // "Petra-s-A06" (owner "Petra", model "A06") is still a Samsung.
    const parsed = host ? parsePhoneName(host) : null;
    const modelKey = parsed?.model ? parsed.model.replace(/ /g, '-') : '';
    const brand = host && PHONE_BRANDS.find(([re]) => re.test(host) || (modelKey && re.test(modelKey)));
    if (brand) {
        const { owner, model } = parsed;
        row.category = brand[2];
        row.mobile = { brand: brand[1], model, owner, guess: false };
        return;
    }
    // No telling name, but a private MAC and no Windows/AD data: most likely
    // a phone or tablet (Windows laptops on Wi-Fi report AD/PC data instead).
    if (row.privateMac) {
        row.category = 'phone';
        row.mobile = { brand: null, model: null, owner: null, guess: true };
    }
}

// SoftwareLicensingProduct.LicenseStatus: 0 unlicensed, 1 licensed,
// 2-6 grace / notification states.
function licenseState(status) {
    if (status === 1) return 'activated';
    if (status === 0) return 'not_activated';
    if (status === 5) return 'notification';
    if ([2, 3, 4, 6].includes(status)) return 'grace';
    return 'unknown';
}

// "Windows(R) Operating System, RETAIL channel" -> "RETAIL"
function licenseChannel(description) {
    const m = String(description ?? '').match(/,\s*([A-Z_]+)\s+channel/i);
    return m ? m[1].toUpperCase() : null;
}

function kmsOf(l) {
    return l.kmsHost || l.kmsDiscovered || null;
}

export function summarizeActivation(p) {
    const win = (p.windowsLicenses ?? []).find((l) => l.partialKey) ?? (p.windowsLicenses ?? [])[0] ?? null;
    const officeLic = (p.officeLicenses ?? []).filter((l) => l.partialKey);
    const officeStates = officeLic.map((l) => licenseState(l.status));
    let officeStatus = 'none';
    if (officeLic.length) {
        if (officeStates.every((x) => x === 'activated')) officeStatus = 'activated';
        else if (officeStates.some((x) => x === 'activated')) officeStatus = 'partial';
        else if (officeStates.some((x) => x === 'grace')) officeStatus = 'grace';
        else officeStatus = 'not_activated';
    } else if ((p.officeProducts ?? []).length) {
        officeStatus = 'unknown';
    }
    return {
        windows: win ? {
            status: licenseState(win.status),
            channel: licenseChannel(win.description),
            name: win.name,
            kmsHost: kmsOf(win),
            graceMinutes: win.graceMinutes,
        } : null,
        office: {
            status: officeStatus,
            products: (p.officeProducts ?? []).map((x) => x.name),
            licenses: officeLic.map((l) => ({
                name: l.name,
                status: licenseState(l.status),
                channel: licenseChannel(l.description),
                kmsHost: kmsOf(l),
                graceMinutes: l.graceMinutes,
            })),
            kmsHosts: [...new Set(officeLic.map(kmsOf).filter(Boolean))],
        },
    };
}

function ipSortKey(ip) {
    if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return Number.MAX_SAFE_INTEGER;
    return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

// ---------------------------------------------------------------------------
// PC health + antivirus (from the PC's own report, Send-PcReport.ps1)
// ---------------------------------------------------------------------------

export const HEALTH_LIMITS = {
    avUpdateDays: 3, // Trend's own "pattern too old" warning is 7 days
    lowDiskPct: 10,
    lowMemoryPct: 10,
    poolNonPagedMb: 800, // normal is 100-400 MB; SALES-25's leak reached 1,647 MB
    commitPct: 90,
    runningDays: 14,
    windowsUpdateDays: 45,
};

// Issues worth a push alert / red on the page; the rest are orange.
export const CRITICAL_ISSUES = ['av_off', 'av_none', 'av_outdated', 'pool_high', 'low_disk'];

// Does Microsoft still ship security updates for this Windows (no paid
// ESU)? Kept simple on purpose -- revisit when a version's end date passes.
//   Windows 11 Home/Pro: 25H2 (build 26200) and newer; 24H2 ended Oct 2026
//   Windows 11 Enterprise/Education: 24H2 (26100) and newer
//   Windows 10: ended 14 Oct 2025, except LTSC/LTSB editions
//   Windows 7 / 8 / 8.1 / XP / Vista, Server 2003 / 2008 / 2012: ended
export function osSupported(caption, versionOrBuild) {
    const cap = String(caption ?? '');
    if (!/windows/i.test(cap)) return null;
    const m = String(versionOrBuild ?? '').match(/(?:10\.0[.\s(]+)?(\d{4,5})/);
    const build = m ? Number(m[1]) : null;
    if (/Server/i.test(cap)) return !/Server (2003|2008|2012)/i.test(cap);
    if (/Windows (XP|Vista|7|8)\b/i.test(cap)) return false;
    if (/Windows 10/i.test(cap)) return /LTS[BC]/i.test(cap);
    if (/Windows 11/i.test(cap)) {
        if (!build) return null;
        return build >= (/Enterprise|Education/i.test(cap) ? 26100 : 26200);
    }
    return null;
}

const daysBetween = (from, to) => {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 86400000 : null;
};
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

function summarizeAntivirus(sec, ref) {
    const L = HEALTH_LIMITS;
    const products = sec.products ?? [];
    const trend = sec.trend;
    const def = sec.defender;
    let status = 'none';
    let product = null;
    let lastUpdate = null;
    let stoppedServices = [];
    if (trend) {
        product = trend.product || 'Trend Micro';
        lastUpdate = trend.lastUpdate;
        const realTime = (trend.services ?? []).find((x) => String(x.name).toLowerCase() === 'ntrtscan');
        const center = products.find((x) => /trend/i.test(x.name ?? ''));
        const age = lastUpdate ? daysBetween(lastUpdate, ref) : null;
        if (!realTime || realTime.state !== 'Running' || (center && !center.enabled)) status = 'off';
        else if (trend.patternTooOld || (age !== null && age > L.avUpdateDays) || (age === null && center && !center.upToDate)) status = 'outdated';
        else status = 'ok';
        stoppedServices = (trend.services ?? [])
            .filter((x) => x.startMode === 'Auto' && x.state !== 'Running')
            .map((x) => x.name);
    } else if (def && (def.serviceEnabled || def.antivirusEnabled)) {
        product = 'Microsoft Defender';
        lastUpdate = def.signatureUpdated;
        const age = lastUpdate ? daysBetween(lastUpdate, ref) : null;
        if (!def.antivirusEnabled || !def.realTime) status = 'off';
        else if (age !== null && age > L.avUpdateDays) status = 'outdated';
        else status = 'ok';
    } else if (products.length) {
        const on = products.find((x) => x.enabled);
        product = (on ?? products[0]).name;
        status = !on ? 'off' : on.upToDate ? 'ok' : 'outdated';
    }
    return {
        status, // ok | off | outdated | none
        product,
        version: trend?.version ?? null,
        lastUpdate,
        lastScan: trend?.lastScheduledScan ?? def?.quickScan ?? null,
        lastInfection: trend?.lastInfection ?? null,
        stoppedServices,
        others: products
            .filter((x) => x.name && x.name !== product && !(trend && /trend/i.test(x.name)))
            .map((x) => ({ name: x.name, enabled: x.enabled })),
    };
}

// -> { av, runningDays, commitPct, windowsUpdateDays, issues[], critical }
// Ages are measured at report time, so a PC that was switched off for a
// week does not show as "not updated" until it reports again.
export function summarizeHealth(p, reportedAt) {
    if (!p) return null;
    const L = HEALTH_LIMITS;
    const ref = reportedAt || new Date().toISOString();
    const issues = [];
    const av = p.security ? summarizeAntivirus(p.security, ref) : null;
    if (av) {
        if (av.status !== 'ok') issues.push(`av_${av.status}`);
        if (av.stoppedServices.length) issues.push('av_service_stopped');
    }

    const h = p.health;
    let runningDays = null;
    let commitPct = null;
    let windowsUpdateDays = null;
    if (h) {
        runningDays = round1(daysBetween(h.lastStart || p.os?.lastBoot, ref));
        commitPct = h.commitGb && h.commitLimitGb ? Math.round((h.commitGb / h.commitLimitGb) * 100) : null;
        windowsUpdateDays = h.updates?.lastCumulative ? Math.floor(daysBetween(h.updates.lastCumulative, ref)) : null;
        if (h.poolNonPagedMb >= L.poolNonPagedMb) issues.push('pool_high');
        if (commitPct !== null && commitPct >= L.commitPct) issues.push('memory_high');
        if (runningDays !== null && runningDays > L.runningDays) issues.push('uptime_long');
        if (h.rebootPending) issues.push('reboot_pending');
        // ESU *licensing preparation* packages are not security updates
        // (older reports counted them).
        if (/Preparation Package/i.test(h.updates?.lastCumulativeName ?? '')) windowsUpdateDays = null;
        if (h.updates && (windowsUpdateDays === null || windowsUpdateDays > L.windowsUpdateDays)) issues.push('updates_old');
    }
    if (osSupported(p.os?.caption, p.os?.build || p.os?.version) === false) issues.push('os_unsupported');

    const hw = p.hardware ?? {};
    if ((hw.volumes ?? []).some((v) => v.sizeGb && v.freeGb !== null && v.freeGb !== undefined
        && (v.freeGb / v.sizeGb) * 100 < L.lowDiskPct)) issues.push('low_disk');
    if (hw.ramGb && hw.ramFreeGb !== null && hw.ramFreeGb !== undefined
        && (hw.ramFreeGb / hw.ramGb) * 100 < L.lowMemoryPct && !issues.includes('memory_high')) issues.push('memory_high');

    return {
        av,
        runningDays,
        commitPct,
        windowsUpdateDays,
        issues,
        critical: issues.some((i) => CRITICAL_ISSUES.includes(i)),
    };
}

// ---------------------------------------------------------------------------
// Windows 11 readiness (PC report "win11" block, 2026-11-25)
// ---------------------------------------------------------------------------

// Supported CPU per Microsoft's lists, simplified: Intel Core 8th gen and
// newer (+ Core Ultra / Core 3-7 series 1+), Pentium Gold G5400+, Celeron
// G4900+, AMD Ryzen 2000+ (except the Zen 1 2x00G/GE/U/H APUs).
// ok: true / false / null (unknown -- Xeon, Athlon, mobile Pentium...).
export function cpuWin11Support(name) {
    const n = String(name ?? '').replaceAll(/\((R|TM)\)/gi, '').replaceAll(/\s+/g, ' ');
    if (/Core Ultra/i.test(n)) return { ok: true, gen: 'Ultra' };
    let m = n.match(/Core i[3579]-(\d{3,5})/i);
    if (m) {
        const d = m[1];
        // i5-10400 / i7-1165G7 / i5-8500 / i5-750
        const gen = d.length === 5 || (d.length === 4 && d[0] === '1') ? Number(d.slice(0, 2))
            : d.length === 4 ? Number(d[0]) : 1;
        return { ok: gen >= 8, gen };
    }
    if (/Core [3579] \d{3}/i.test(n)) return { ok: true, gen: 'Core' };
    if (/Core ?2|Pentium Dual|Pentium 4|Pentium D\b|Celeron D\b|Atom/i.test(n)) return { ok: false, gen: null };
    // Pentium G850 / Celeron G530 (3 digits) are 2011-2012 parts
    if (/(Pentium|Celeron).*\bG\d{3}\b/i.test(n)) return { ok: false, gen: null };
    m = n.match(/Pentium.*\bG(\d{4})/i);
    if (m) return { ok: Number(m[1]) >= 5400, gen: null };
    m = n.match(/Celeron.*\bG(\d{4})/i);
    if (m) return { ok: Number(m[1]) >= 4900, gen: null };
    m = n.match(/Ryzen (?:AI|Threadripper)/i);
    if (m) return { ok: true, gen: 'Ryzen' };
    m = n.match(/Ryzen \d (?:PRO )?(\d)(\d{3})([A-Z]*)/i);
    if (m) {
        const series = Number(m[1]);
        const zen1Apu = series === 2 && /^(G|GE|U|H)$/i.test(m[3]);
        return { ok: series >= 2 && !zen1Apu, gen: `Ryzen ${series}000` };
    }
    return { ok: null, gen: null };
}

// -> { status: already | ready | fixable | no | unknown, hard[], fix[], cpuGen }
//   hard = needs new hardware (cpu, ram, disk, arch, tpm_12 on an old CPU)
//   fix  = BIOS/firmware settings IT can change (tpm_off, legacy_bios,
//          secure_boot_off; tpm_12 on a supported CPU = switch to PTT/fTPM 2.0)
export function win11Readiness(p) {
    if (!p) return null;
    const w = p.win11;
    if (/Windows 11/i.test(p.os?.caption ?? '')) return { status: 'already', hard: [], fix: [], cpuGen: null };
    if (!w) {
        // Report from before the win11 block: the CPU alone can already say "no".
        const c = cpuWin11Support(p.hardware?.cpu?.name);
        return c.ok === false ? { status: 'no', hard: ['cpu'], fix: [], cpuGen: c.gen, partial: true } : null;
    }
    const hard = [];
    const fix = [];
    const cpu = cpuWin11Support(p.hardware?.cpu?.name);
    if (cpu.ok === false) hard.push('cpu');
    if (p.hardware?.ramGb && p.hardware.ramGb < 3.5) hard.push('ram');
    const sys = (p.hardware?.volumes ?? []).find((v) => String(v.drive).toUpperCase() === 'C:');
    if (sys?.sizeGb && sys.sizeGb < 60) hard.push('disk');
    if (w.arch && !/64/.test(w.arch)) hard.push('arch');
    const tpmVer = Number.parseFloat(String(w.tpm?.specVersion ?? '').split(',')[0]);
    if (!w.tpmPresent) fix.push('tpm_off');
    else if (Number.isFinite(tpmVer) && tpmVer < 2) (cpu.ok ? fix : hard).push('tpm_12');
    else if (w.tpm && (!w.tpm.enabled || !w.tpm.activated)) fix.push('tpm_off');
    if (/legacy/i.test(w.firmware ?? '')) fix.push('legacy_bios');
    else if (w.secureBoot === false) fix.push('secure_boot_off');
    const status = hard.length ? 'no' : cpu.ok === null ? 'unknown' : fix.length ? 'fixable' : 'ready';
    return { status, hard, fix, cpuGen: cpu.gen };
}

// AD computer accounts that have not signed in for this long are treated as
// gone: their DNS IP is not trusted for matching (see the AD merge above).
export const STALE_AD_DAYS = 90;

// In use lately: reported by itself or signed in to AD in the last 60 days,
// or seen on the network while not tied to an old AD account. A device that
// only "answers" because an old AD account's name still resolves is not.
export function isActiveDevice(d, days = 60) {
    const since = Date.now() - days * 86400000;
    if (d.pc?.reportedAt && Date.parse(d.pc.reportedAt) > since) return true;
    if (d.ad?.lastLogon && Date.parse(d.ad.lastLogon) > since) return true;
    return Boolean(d.online && !d.ad);
}
