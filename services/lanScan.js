// backend/services/lanScan.js
// LAN scan for the IT network page (2026-11-21) -- the "who is online now"
// source when the Meraki API isn't available. Every 5 minutes the server
// pings every address of NETWORK_SCAN_SUBNETS (default 192.168.20.0/24, the
// server's own subnet), then reads its ARP table: a device that answered
// ARP is online even if its firewall drops ping. ARP only works inside the
// server's own subnet, so hosts on other subnets (Ittihad / Thuhaiba over
// the VPN) are reported by ping alone and without a MAC.
//
// Snapshot 'lan_scan': { scannedAt, subnets, hosts: [{ ip, mac, alive,
// rttMs, name, lastSeen }] } -- hosts not seen this round are kept with
// their old lastSeen for 7 days so the page can say "last seen 2 days ago".
import { execFile } from 'child_process';
import dns from 'dns/promises';
import { NetworkSnapshot } from '../models/Network.js';
import { checkHost, saveSnapshot, saveSnapshotError } from './networkMonitor.js';
import { normalizeMac } from './networkInventory.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const CONCURRENCY = 64;
const KEEP_DAYS = 7;

// "192.168.20.0/24, 192.168.1.0/24" -> ['192.168.20.1', ...]. /22 at most.
export function expandSubnets(spec) {
    const ips = [];
    for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = part.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
        if (!m) continue;
        const bits = Number(m[5]);
        if (bits < 22 || bits > 30) continue;
        const base = ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
        const size = 2 ** (32 - bits);
        const network = base - (base % size);
        for (let i = 1; i < size - 1; i++) {
            const n = network + i;
            ips.push([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
        }
    }
    return [...new Set(ips)];
}

// IP -> MAC from `arp -a` (Windows: "  192.168.20.1   00-15-5d-c4-39-1c   dynamic";
// Linux: "? (192.168.20.1) at 00:15:5d:c4:39:1c [ether] on eth0").
function readArpTable() {
    return new Promise((resolve) => {
        execFile('arp', ['-a'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
            const map = new Map();
            for (const line of String(stdout || '').split(/\r?\n/)) {
                const m = line.match(/(\d+\.\d+\.\d+\.\d+)\)?\s+(?:at\s+)?([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})/);
                if (!m) continue;
                const mac = normalizeMac(m[2]);
                if (!mac || mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e')) continue;
                map.set(m[1], mac);
            }
            resolve(map);
        });
    });
}

async function reverseName(ip) {
    try {
        const names = await Promise.race([
            dns.reverse(ip),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ]);
        return names[0] ?? null;
    } catch {
        return null;
    }
}

let running = false;

export async function runLanScan() {
    if (running) return;
    running = true;
    try {
        const subnets = process.env.NETWORK_SCAN_SUBNETS || '192.168.20.0/24';
        const ips = expandSubnets(subnets);
        if (ips.length === 0) return;

        const results = new Map();
        for (let i = 0; i < ips.length; i += CONCURRENCY) {
            await Promise.all(ips.slice(i, i + CONCURRENCY).map(async (ip) => {
                const r = await checkHost(ip, null);
                results.set(ip, r);
            }));
        }
        const arp = await readArpTable();

        const now = new Date().toISOString();
        const alive = [];
        for (const ip of ips) {
            const r = results.get(ip);
            const mac = arp.get(ip) ?? null;
            if (r?.ok || mac) alive.push({ ip, mac, rttMs: r?.ok ? r.rttMs : null, pingBlocked: !r?.ok });
        }
        await Promise.all(alive.map(async (h) => { h.name = await reverseName(h.ip); }));

        // Carry over hosts not seen this round (by MAC, else IP) for KEEP_DAYS.
        const prevRow = await NetworkSnapshot.findByPk('lan_scan');
        let prev = [];
        try { prev = prevRow?.data ? JSON.parse(prevRow.data).hosts ?? [] : []; } catch { prev = []; }
        const keyOf = (h) => h.mac || `ip:${h.ip}`;
        const seen = new Set(alive.map(keyOf));
        const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        const hosts = alive.map((h) => ({ ...h, alive: true, lastSeen: now }));
        for (const h of prev) {
            if (seen.has(keyOf(h)) || !h.lastSeen || Date.parse(h.lastSeen) < cutoff) continue;
            hosts.push({ ...h, alive: false, rttMs: null });
        }

        await saveSnapshot('lan_scan', { scannedAt: now, subnets, hosts });
    } catch (err) {
        console.error('❌ LAN scan failed:', err);
        await saveSnapshotError('lan_scan', err).catch(() => {});
    } finally {
        running = false;
    }
}

export function startLanScan() {
    setTimeout(runLanScan, 30 * 1000);
    setInterval(runLanScan, SCAN_INTERVAL_MS);
}
