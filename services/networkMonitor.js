// backend/services/networkMonitor.js
// Background half of the IT network page (routes/network.js), 2026-11-21:
//
// 1. Meraki poll (every 5 min, only when MERAKI_API_KEY is set): networks,
//    device statuses, MX uplinks, site-to-site VPN and every network's
//    clients seen in the last 24 h -> one NetworkSnapshots row each.
// 2. Ping/port monitor (every minute): each enabled NetworkMonitorTargets
//    row is pinged (or TCP-connected when it has a port). A host is "down"
//    after 3 failed checks in a row, so one lost packet never alerts.
//
// Down/up changes -- monitored hosts, Meraki devices going offline/online,
// an MX uplink failing -- are pushed to admin + every role granted
// PERMISSIONS.IT_NETWORK. Started from index.js only when
// DISABLE_BACKGROUND_JOBS isn't set (i.e. on PETRA-APP, not the dev PC).
import { execFile } from 'child_process';
import net from 'net';
import { Op } from 'sequelize';
import { NetworkSnapshot, NetworkMonitorTarget } from '../models/Network.js';
import { User } from '../models/User.js';
import { PermissionGrant } from '../models/PermissionGrant.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sendPushToUser } from './pushNotifications.js';
import { merakiConfigured, merakiGet, getOrgId } from './merakiClient.js';

const PING_INTERVAL_MS = 60 * 1000;
const MERAKI_INTERVAL_MS = 5 * 60 * 1000;
const MANUAL_REFRESH_MIN_GAP_MS = 30 * 1000;
const DOWN_AFTER_FAILS = 3;
const PING_CONCURRENCY = 10;
const PING_TIMEOUT_MS = 1500;
const TCP_TIMEOUT_MS = 3000;
const CLIENT_TIMESPAN_S = 24 * 60 * 60;

// Hostnames / IPv4 / IPv6 only -- the value goes to ping's argv (execFile,
// no shell), but never let anything that looks like a flag through.
export const HOST_RE = /^(?=.{1,255}$)[A-Za-z0-9](?:[A-Za-z0-9.\-:]*[A-Za-z0-9])?$/;

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export async function saveSnapshot(source, data) {
    await NetworkSnapshot.upsert({
        source,
        data: JSON.stringify(data),
        fetchedAt: new Date(),
        error: null,
        errorAt: null,
    });
}

export async function saveSnapshotError(source, err) {
    const message = String(err?.message || err).slice(0, 500);
    const existing = await NetworkSnapshot.findByPk(source);
    if (existing) {
        await existing.update({ error: message, errorAt: new Date() });
    } else {
        await NetworkSnapshot.create({ source, data: null, error: message, errorAt: new Date() });
    }
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

async function getAlertUserIds() {
    const grants = await PermissionGrant.findAll({
        where: { permissionKey: PERMISSIONS.IT_NETWORK },
        attributes: ['role'],
    });
    const roles = ['admin', ...grants.map((g) => g.role)];
    const users = await User.findAll({
        where: { role: { [Op.in]: roles }, active: true },
        attributes: ['userId'],
    });
    return users.map((u) => u.userId);
}

export async function pushAlert(title, body, url = '/admin/it-network') {
    try {
        const userIds = await getAlertUserIds();
        await Promise.all(userIds.map((userId) =>
            sendPushToUser(userId, { title, body, data: { type: 'it_network', url } })));
    } catch (err) {
        console.error('❌ Network alert push failed:', err);
    }
}

// ---------------------------------------------------------------------------
// Meraki
// ---------------------------------------------------------------------------

// Only the client fields the page uses -- keeps the snapshot row small.
function trimClient(c, network) {
    return {
        id: c.id,
        mac: c.mac ? String(c.mac).toLowerCase() : null,
        description: c.description ?? null,
        ip: c.ip ?? null,
        user: c.user ?? null,
        firstSeen: c.firstSeen ?? null,
        lastSeen: c.lastSeen ?? null,
        manufacturer: c.manufacturer ?? null,
        os: c.os ?? null,
        deviceTypePrediction: c.deviceTypePrediction ?? null,
        recentDeviceName: c.recentDeviceName ?? null,
        recentDeviceConnection: c.recentDeviceConnection ?? null,
        ssid: c.ssid ?? null,
        vlan: c.vlan ?? null,
        switchport: c.switchport ?? null,
        status: c.status ?? null,
        notes: c.notes ?? null,
        usage: c.usage ? { sent: c.usage.sent ?? 0, recv: c.usage.recv ?? 0 } : null,
        networkId: network.id,
        networkName: network.name,
    };
}

// serial -> 'online' | 'offline' | ... from the previous poll (memory only:
// the first poll after a restart never alerts).
let lastDeviceStatus = null;
// `${serial}|${interface}` -> status
let lastUplinkStatus = null;

function alertDeviceChanges(devices, uplinks) {
    const deviceNow = new Map(devices.map((d) => [d.serial, d.status]));
    if (lastDeviceStatus) {
        for (const d of devices) {
            const before = lastDeviceStatus.get(d.serial);
            if (!before || before === d.status) continue;
            const name = d.name || d.model || d.serial;
            if (d.status === 'offline') {
                pushAlert('🔴 Network device offline', `${name} (${d.model}) went offline.`);
            } else if (before === 'offline' && d.status === 'online') {
                pushAlert('🟢 Network device back online', `${name} (${d.model}) is online again.`);
            }
        }
    }
    lastDeviceStatus = deviceNow;

    const uplinkNow = new Map();
    for (const u of uplinks) {
        for (const link of u.uplinks ?? []) {
            uplinkNow.set(`${u.serial}|${link.interface}`, link.status);
        }
    }
    if (lastUplinkStatus) {
        for (const [key, status] of uplinkNow) {
            const before = lastUplinkStatus.get(key);
            if (!before || before === status) continue;
            const [serial, iface] = key.split('|');
            const device = devices.find((d) => d.serial === serial);
            const name = device?.name || serial;
            if (status === 'failed') {
                pushAlert('🔴 Internet line down', `${name}: ${iface.toUpperCase()} uplink failed.`);
            } else if (before === 'failed' && status === 'active') {
                pushAlert('🟢 Internet line back', `${name}: ${iface.toUpperCase()} uplink is active again.`);
            }
        }
    }
    lastUplinkStatus = uplinkNow;
}

let merakiRunning = false;
let lastMerakiRunAt = 0;

export async function pollMeraki() {
    if (!merakiConfigured() || merakiRunning) return { skipped: true };
    merakiRunning = true;
    lastMerakiRunAt = Date.now();
    try {
        let orgId;
        try {
            orgId = await getOrgId();
        } catch (err) {
            for (const s of ['meraki_networks', 'meraki_devices', 'meraki_uplinks', 'meraki_vpn', 'meraki_clients']) {
                await saveSnapshotError(s, err);
            }
            return { ok: false, error: err.message };
        }

        // Each source on its own, so one failing endpoint (e.g. VPN on an
        // org without it) doesn't blank out the rest.
        const step = async (source, fn) => {
            try {
                const data = await fn();
                await saveSnapshot(source, data);
                return data;
            } catch (err) {
                console.error(`❌ Meraki ${source}:`, err.message);
                await saveSnapshotError(source, err);
                return null;
            }
        };

        const networks = await step('meraki_networks', async () => {
            const list = await merakiGet(`/organizations/${orgId}/networks`);
            return list.map((n) => ({ id: n.id, name: n.name, productTypes: n.productTypes ?? [], timeZone: n.timeZone }));
        });
        const devices = await step('meraki_devices', () =>
            merakiGet(`/organizations/${orgId}/devices/statuses`));
        const uplinks = await step('meraki_uplinks', () =>
            merakiGet(`/organizations/${orgId}/appliance/uplink/statuses`));
        await step('meraki_vpn', () =>
            merakiGet(`/organizations/${orgId}/appliance/vpn/statuses`));

        if (networks) {
            await step('meraki_clients', async () => {
                const all = [];
                for (const network of networks) {
                    const types = network.productTypes;
                    if (!types.some((t) => ['appliance', 'switch', 'wireless'].includes(t))) continue;
                    const clients = await merakiGet(
                        `/networks/${network.id}/clients?timespan=${CLIENT_TIMESPAN_S}&perPage=1000`,
                    );
                    for (const c of clients) all.push(trimClient(c, network));
                }
                return all;
            });
        }

        if (devices && uplinks) alertDeviceChanges(devices, uplinks);
        return { ok: true };
    } finally {
        merakiRunning = false;
    }
}

// The page's "Refresh now" button -- at most once per 30 s.
export async function refreshMerakiNow() {
    if (!merakiConfigured()) return { ok: false, error: 'MERAKI_API_KEY is not set on the server' };
    if (Date.now() - lastMerakiRunAt < MANUAL_REFRESH_MIN_GAP_MS) {
        return { ok: false, error: 'Refreshed less than 30 seconds ago -- try again shortly' };
    }
    return pollMeraki();
}

// ---------------------------------------------------------------------------
// ping / port monitor
// ---------------------------------------------------------------------------

function icmpPing(host) {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        const args = isWin
            ? ['-n', '1', '-w', String(PING_TIMEOUT_MS), host]
            : ['-c', '1', '-W', String(Math.ceil(PING_TIMEOUT_MS / 1000)), host];
        const started = Date.now();
        execFile('ping', args, { timeout: PING_TIMEOUT_MS + 3000, windowsHide: true }, (err, stdout) => {
            const out = String(stdout || '');
            // Windows exits 0 on "Destination host unreachable" replies from
            // the gateway, so success means a reply with a TTL.
            const ok = isWin ? /TTL=/i.test(out) : !err;
            if (!ok) {
                const reason = /could not find host/i.test(out) ? 'Host name not found'
                    : /unreachable/i.test(out) ? 'Destination unreachable'
                        : 'No reply';
                return resolve({ ok: false, error: reason });
            }
            const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
            resolve({ ok: true, rttMs: m ? Math.round(Number(m[1])) : Date.now() - started });
        });
    });
}

function tcpCheck(host, port) {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = net.createConnection({ host, port });
        const done = (result) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(TCP_TIMEOUT_MS);
        socket.once('connect', () => done({ ok: true, rttMs: Date.now() - started }));
        socket.once('timeout', () => done({ ok: false, error: `Port ${port}: timed out` }));
        socket.once('error', (err) => done({ ok: false, error: `Port ${port}: ${err.code || err.message}` }));
    });
}

export function checkHost(host, port) {
    if (!HOST_RE.test(host)) return Promise.resolve({ ok: false, error: 'Invalid host' });
    return port ? tcpCheck(host, port) : icmpPing(host);
}

async function checkTarget(target) {
    const result = await checkHost(target.host, target.port);
    const now = new Date();
    const update = { lastCheckedAt: now };
    const before = target.status;
    if (result.ok) {
        update.lastRttMs = result.rttMs;
        update.consecutiveFails = 0;
        update.lastError = null;
        if (before !== 'up') {
            update.status = 'up';
            update.lastChangeAt = now;
            if (before === 'down' && target.notify) {
                pushAlert('🟢 Back up', `${target.name} (${target.host}) is reachable again.`);
            }
        }
    } else {
        const fails = target.consecutiveFails + 1;
        update.consecutiveFails = fails;
        update.lastError = result.error?.slice(0, 255) ?? 'No reply';
        update.lastRttMs = null;
        if (fails >= DOWN_AFTER_FAILS && before !== 'down') {
            update.status = 'down';
            update.lastChangeAt = now;
            if (target.notify) {
                pushAlert('🔴 Host down', `${target.name} (${target.host}) is not responding: ${update.lastError}.`);
            }
        }
    }
    await target.update(update);
}

let pingRunning = false;

export async function runPingChecks() {
    if (pingRunning) return;
    pingRunning = true;
    try {
        const targets = await NetworkMonitorTarget.findAll({ where: { enabled: true } });
        for (let i = 0; i < targets.length; i += PING_CONCURRENCY) {
            await Promise.all(targets.slice(i, i + PING_CONCURRENCY).map((t) =>
                checkTarget(t).catch((err) => console.error(`❌ Monitor ${t.host}:`, err.message))));
        }
    } catch (err) {
        console.error('❌ Network ping checks failed:', err);
    } finally {
        pingRunning = false;
    }
}

export function startNetworkMonitor() {
    console.log(`🌐 Network monitor started (ping every ${PING_INTERVAL_MS / 1000}s`
        + `${merakiConfigured() ? `, Meraki every ${MERAKI_INTERVAL_MS / 60000} min` : ', Meraki off: no MERAKI_API_KEY'})`);
    setTimeout(() => {
        runPingChecks();
        pollMeraki().catch((err) => console.error('❌ Meraki poll failed:', err));
    }, 15 * 1000);
    setInterval(runPingChecks, PING_INTERVAL_MS);
    setInterval(() => {
        pollMeraki().catch((err) => console.error('❌ Meraki poll failed:', err));
    }, MERAKI_INTERVAL_MS);
}
