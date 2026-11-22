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
    const computers = snaps.ad?.data?.computers ?? [];
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
        const ipRow = c.ipv4 ? byIp.get(c.ipv4) : null;
        const ipMatch = ipRow && !ipRow.dhcp?.hostName && !ipRow.reservation?.name ? ipRow : null;
        const row = free(byName.get(s)) || free(ipMatch) || get(`ad:${s.toUpperCase()}`);
        if (!row.sources.includes('ad')) row.sources.push('ad');
        row.ad = {
            name: c.name,
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
        row.ip = row.ip || c.ipv4 || null;
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
