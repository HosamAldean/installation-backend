// backend/routes/network.js
// IT network page (frontend admin/it-network), 2026-11-21. Gated by
// PERMISSIONS.IT_NETWORK; the RDP download additionally needs IT_REMOTE.
//
// Data: services/networkMonitor.js (Meraki poll + ping monitor) and
// POST /ingest below, which DC3's scheduled script
// (scripts/dc3/Send-NetworkInventory.ps1) calls with DHCP + AD data. The
// ingest route has no user session -- it's authenticated by the shared
// NETWORK_INGEST_TOKEN header instead, and is the only route here that is.
import crypto from "crypto";
import fs from "fs/promises";
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { NetworkMonitorTarget, NetworkDeviceNote, NetworkSnapshot, NETWORK_TARGET_KINDS } from "../models/Network.js";
import { AdminActionAudit } from "../models/AdminActionAudit.js";
import { merakiConfigured } from "../services/merakiClient.js";
import {
    HOST_RE, checkHost, refreshMerakiNow, saveSnapshot, pushAlert,
} from "../services/networkMonitor.js";
import { buildDeviceList, loadSnapshots, normalizeMac, summarizeHealth, isActiveDevice } from "../services/networkInventory.js";
import { buildOps, refreshCerts } from "../services/itOps.js";

const router = express.Router();

function logAction({ entityId, entityLabel, action, changes, req }) {
    AdminActionAudit.create({
        module: "it_network",
        entityId: String(entityId),
        entityLabel: entityLabel ?? null,
        action,
        changes: changes ? JSON.stringify(changes) : null,
        performedByUserId: req.user?.userId ?? null,
    }).catch((err) => {
        console.error("❌ Failed to record admin action audit:", err);
    });
}

// ---------------------------------------------------------------------------
// POST /ingest -- DHCP + AD inventory from DC3 (token auth, no session)
// ---------------------------------------------------------------------------

function tokenMatches(given, expected = process.env.NETWORK_INGEST_TOKEN) {
    if (!expected || typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MAX_ITEMS = 5000;
const s = (v, max = 255) => (v === null || v === undefined ? null : String(v).slice(0, max));
const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);

router.post("/ingest", async (req, res) => {
    if (!process.env.NETWORK_INGEST_TOKEN) {
        return res.status(503).json({ success: false, message: "Ingest is not configured" });
    }
    if (!tokenMatches(req.get("x-ingest-token"))) {
        return res.status(401).json({ success: false, message: "Bad token" });
    }
    try {
        const { dhcp, ad, logons, backup, hygiene, softwareShare } = req.body ?? {};
        const saved = [];
        if (dhcp && typeof dhcp === "object") {
            await saveSnapshot("dhcp", {
                server: s(dhcp.server, 100),
                scopes: list(dhcp.scopes).map((x) => ({
                    scopeId: s(x.scopeId, 45),
                    name: s(x.name, 100),
                    startRange: s(x.startRange, 45),
                    endRange: s(x.endRange, 45),
                    state: s(x.state, 20),
                    inUse: Number(x.inUse) || 0,
                    free: Number(x.free) || 0,
                    percentInUse: Number(x.percentInUse) || 0,
                })),
                leases: list(dhcp.leases).filter((x) => normalizeMac(x.mac)).map((x) => ({
                    ip: s(x.ip, 45),
                    mac: normalizeMac(x.mac),
                    hostName: s(x.hostName, 255),
                    addressState: s(x.addressState, 40),
                    leaseExpiry: s(x.leaseExpiry, 40),
                    scopeId: s(x.scopeId, 45),
                })),
                reservations: list(dhcp.reservations).filter((x) => normalizeMac(x.mac)).map((x) => ({
                    ip: s(x.ip, 45),
                    mac: normalizeMac(x.mac),
                    name: s(x.name, 255),
                    description: s(x.description, 255),
                    scopeId: s(x.scopeId, 45),
                })),
            });
            saved.push("dhcp");
        }
        if (ad && typeof ad === "object") {
            // One snapshot per domain: petralu.local keeps 'ad'; another
            // domain (PETRATH-DC01 sends domain "PETRATH") gets 'ad_PETRATH'
            // so it doesn't overwrite petralu's list.
            const domain = String(ad.domain ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20);
            const adKey = !domain || domain === "PETRALU" ? "ad" : `ad_${domain}`;
            await saveSnapshot(adKey, {
                domain: domain || "PETRALU",
                computers: list(ad.computers).filter((x) => x?.name).map((x) => ({
                    name: s(x.name, 64),
                    dnsHostName: s(x.dnsHostName, 255),
                    os: s(x.os, 100),
                    osVersion: s(x.osVersion, 60),
                    enabled: x.enabled !== false,
                    lastLogon: s(x.lastLogon, 40),
                    description: s(x.description, 255),
                    ou: s(x.ou, 255),
                    ipv4: s(x.ipv4, 45),
                })),
            });
            saved.push(adKey);
        }
        // Last domain user per IP, one snapshot per DC (each DC only sees
        // the logons it served) -- merged by services/networkInventory.js.
        if (logons && typeof logons === "object") {
            const dc = String(logons.dc ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 30);
            if (!dc) return res.status(400).json({ success: false, message: "logons.dc is required" });
            await saveSnapshot(`logons_${dc}`, {
                dc,
                items: list(logons.items).filter((x) => x?.ip && x?.user).map((x) => ({
                    ip: s(x.ip, 45),
                    user: s(x.user, 100),
                    domain: s(x.domain, 50),
                    time: s(x.time, 40),
                })),
            });
            saved.push(`logons_${dc}`);
        }
        // Veeam jobs + repositories from the backup host
        // (scripts/veeam/Send-VeeamStatus.ps1), for the IT ops page.
        if (backup && typeof backup === "object") {
            const iso = (v) => s(v, 40);
            await saveSnapshot("backup", {
                server: s(backup.server, 100),
                version: s(backup.version, 40),
                jobs: list(backup.jobs).filter((j) => j?.name).slice(0, 200).map((j) => ({
                    name: s(j.name, 150),
                    type: s(j.type, 60),
                    enabled: j.enabled !== false,
                    lastResult: s(j.lastResult, 30),
                    sizeGb: Number.isFinite(Number(j.sizeGb)) ? Number(j.sizeGb) : null,
                    sessions: list(j.sessions).slice(0, 15).map((x) => ({
                        start: iso(x.start), end: iso(x.end), result: s(x.result, 30),
                    })),
                })),
                repositories: list(backup.repositories).slice(0, 50).map((r) => ({
                    name: s(r.name, 150),
                    path: s(r.path, 255),
                    totalGb: Number(r.totalGb) || 0,
                    freeGb: Number(r.freeGb) || 0,
                })),
            });
            saved.push("backup");
        }
        // Installers in the IT software share (PETRA-FILES Software$, F:\Software),
        // from scripts/software/Send-SoftwareShare.ps1, for the Software Library page.
        if (softwareShare && typeof softwareShare === "object") {
            await saveSnapshot("software_share", {
                server: s(softwareShare.server, 64),
                root: s(softwareShare.root, 255),
                files: list(softwareShare.files).filter((f) => f?.path).slice(0, 2000).map((f) => ({
                    path: s(f.path, 500),
                    name: s(f.name, 255),
                    folder: s(f.folder, 400),
                    sizeMb: Number(f.sizeMb) || 0,
                    modified: s(f.modified, 40),
                    sha256: /^[0-9a-f]{64}$/i.test(String(f.sha256 ?? "")) ? String(f.sha256).toLowerCase() : null,
                    version: s(f.version, 60),
                    product: s(f.product, 200),
                    company: s(f.company, 150),
                })),
            });
            saved.push("software_share");
        }
        // AD + DNS hygiene from each DC (Send-NetworkInventory.ps1 -Parts hygiene).
        if (hygiene && typeof hygiene === "object") {
            const domain = String(hygiene.domain ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20);
            if (!domain) return res.status(400).json({ success: false, message: "hygiene.domain is required" });
            const people = (v) => list(v).slice(0, 300).map((u) => ({
                name: s(u.name, 100),
                display: s(u.display, 150),
                lastLogon: s(u.lastLogon, 40),
                pwdLastSet: s(u.pwdLastSet, 40),
                created: s(u.created, 40),
                os: s(u.os, 100),
            }));
            await saveSnapshot(`hygiene_${domain}`, {
                domain,
                dc: s(hygiene.dc, 50),
                dcs: list(hygiene.dcs).slice(0, 20).map((d) => ({
                    name: s(d.name, 64), ip: s(d.ip, 45), ips: list(d.ips).slice(0, 10).map((x) => s(x, 45)),
                })),
                computers: {
                    enabled: Number(hygiene.computers?.enabled) || 0,
                    staleCount: Number(hygiene.computers?.staleCount) || 0,
                    staleEnabled: people(hygiene.computers?.staleEnabled),
                },
                users: {
                    enabled: Number(hygiene.users?.enabled) || 0,
                    staleCount: Number(hygiene.users?.staleCount) || 0,
                    oldPwCount: Number(hygiene.users?.oldPwCount) || 0,
                    pwdNeverExpires: Number(hygiene.users?.pwdNeverExpires) || 0,
                    neverLoggedOn: Number(hygiene.users?.neverLoggedOn) || 0,
                    staleEnabled: people(hygiene.users?.staleEnabled),
                    oldPasswords: people(hygiene.users?.oldPasswords),
                },
                admins: list(hygiene.admins).slice(0, 10).map((g) => ({
                    group: s(g.group, 100),
                    members: list(g.members).slice(0, 100).map((m) => s(m, 100)),
                })),
                dns: hygiene.dns ? {
                    zone: s(hygiene.dns.zone, 100),
                    dynamicUpdate: s(hygiene.dns.dynamicUpdate, 40),
                    aging: Boolean(hygiene.dns.aging),
                    scavenging: Boolean(hygiene.dns.scavenging),
                    apex: list(hygiene.dns.apex).slice(0, 1000).map((a) => ({
                        ip: s(a.ip, 45), stamp: s(a.stamp, 40), static: Boolean(a.static),
                    })),
                } : null,
            });
            saved.push(`hygiene_${domain}`);
        }
        res.json({ success: true, saved });
    } catch (err) {
        console.error("❌ Network ingest failed:", err);
        res.status(500).json({ success: false, message: "Ingest failed" });
    }
});

// ---------------------------------------------------------------------------
// POST /report -- one PC reporting about itself (scripts/pc/Send-PcReport.ps1,
// run on every domain PC by GPO as SYSTEM): Windows + Office activation,
// installed Office, logged-on user, NICs. Its own NETWORK_REPORT_TOKEN,
// separate from the DC ingest token on purpose: this one sits in SYSVOL
// where any domain user can read it, so all it can ever do is overwrite one
// PC's report row ("pc:<NAME>") -- never DHCP/AD/logon data.
// ---------------------------------------------------------------------------

const PC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

// PowerShell 5.1's ConvertTo-Json turns a one-item array into a bare object.
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function licenseList(v) {
    return asArray(v).slice(0, 60).map((l) => ({
        name: s(l?.name, 150),
        description: s(l?.description, 150),
        status: Number.isInteger(l?.status) ? l.status : null,
        partialKey: s(l?.partialKey, 10),
        kmsHost: s(l?.kmsHost, 150),
        kmsDiscovered: s(l?.kmsDiscovered, 150),
        graceMinutes: Number.isFinite(l?.graceMinutes) ? l.graceMinutes : null,
    }));
}

const bool = (v) => (typeof v === "boolean" ? v : null);

function securityReport(v) {
    if (!v || typeof v !== "object") return null;
    const t = v.trend;
    const d = v.defender;
    return {
        products: asArray(v.products).slice(0, 10).map((p) => ({
            name: s(p?.name, 100),
            state: num(p?.state),
            enabled: bool(p?.enabled),
            upToDate: bool(p?.upToDate),
        })),
        defender: d && typeof d === "object" ? {
            mode: s(d.mode, 40),
            serviceEnabled: bool(d.serviceEnabled),
            antivirusEnabled: bool(d.antivirusEnabled),
            realTime: bool(d.realTime),
            signatureUpdated: s(d.signatureUpdated, 40),
            quickScan: s(d.quickScan, 40),
        } : null,
        trend: t && typeof t === "object" ? {
            product: s(t.product, 100),
            version: s(t.version, 40),
            lastUpdate: s(t.lastUpdate, 40),
            patternTooOld: bool(t.patternTooOld),
            patternDate: s(t.patternDate, 40),
            lastScheduledScan: s(t.lastScheduledScan, 40),
            lastInfection: s(t.lastInfection, 40),
            services: asArray(t.services).slice(0, 10).map((x) => ({
                name: s(x?.name, 40),
                state: s(x?.state, 20),
                startMode: s(x?.startMode, 20),
            })),
        } : null,
    };
}

function win11Report(v) {
    if (!v || typeof v !== "object") return null;
    return {
        firmware: s(v.firmware, 20),
        secureBoot: bool(v.secureBoot),
        tpmPresent: bool(v.tpmPresent),
        tpm: v.tpm && typeof v.tpm === "object" ? {
            specVersion: s(v.tpm.specVersion, 40),
            enabled: bool(v.tpm.enabled),
            activated: bool(v.tpm.activated),
        } : null,
        arch: s(v.arch, 20),
        cpuMaker: s(v.cpuMaker, 40),
        cpuCaption: s(v.cpuCaption, 100),
    };
}

function healthReport(v) {
    if (!v || typeof v !== "object") return null;
    const u = v.updates;
    return {
        lastStart: s(v.lastStart, 40),
        fastStartup: bool(v.fastStartup),
        poolNonPagedMb: num(v.poolNonPagedMb),
        poolPagedMb: num(v.poolPagedMb),
        commitGb: num(v.commitGb),
        commitLimitGb: num(v.commitLimitGb),
        topProcesses: asArray(v.topProcesses).slice(0, 5).map((p) => ({ name: s(p?.name, 80), mb: num(p?.mb) })),
        rebootPending: bool(v.rebootPending),
        updates: u && typeof u === "object" ? {
            lastInstalled: s(u.lastInstalled, 40),
            lastTitle: s(u.lastTitle, 200),
            lastCumulative: s(u.lastCumulative, 40),
            lastCumulativeName: s(u.lastCumulativeName, 200),
            failed30d: num(u.failed30d),
        } : null,
    };
}

// Push alert (same recipients as the network alerts) when a PC's report
// turns an antivirus or kernel-memory problem on or off. Only between two
// reports that both carry the new fields, so rolling the script out does
// not send one alert per PC.
const ALERT_ISSUES = {
    av_off: "antivirus is OFF",
    av_none: "no antivirus",
    av_outdated: "antivirus not updated",
    pool_high: "kernel memory leak (non-paged pool high)",
};

function alertHealthChange(name, prevData, prevAt, nextData) {
    if (!prevData?.security || !nextData.security) return;
    const before = new Set(summarizeHealth(prevData, prevAt)?.issues ?? []);
    const after = summarizeHealth(nextData, new Date().toISOString());
    const now = new Set(after?.issues ?? []);
    const raised = Object.keys(ALERT_ISSUES).filter((k) => now.has(k) && !before.has(k));
    const cleared = Object.keys(ALERT_ISSUES).filter((k) => before.has(k) && !now.has(k));
    if (raised.length) {
        const extra = raised.includes("pool_high") ? ` (${nextData.health?.poolNonPagedMb} MB)` : "";
        pushAlert("🔴 PC problem", `${name}: ${raised.map((k) => ALERT_ISSUES[k]).join(", ")}${extra}.`);
    }
    if (cleared.length) {
        pushAlert("🟢 PC OK again", `${name}: ${cleared.map((k) => ALERT_ISSUES[k]).join(", ")} -- fixed.`);
    }
}

router.post("/report", async (req, res) => {
    if (!process.env.NETWORK_REPORT_TOKEN) {
        return res.status(503).json({ success: false, message: "PC reports are not configured" });
    }
    if (!tokenMatches(req.get("x-report-token"), process.env.NETWORK_REPORT_TOKEN)) {
        return res.status(401).json({ success: false, message: "Bad token" });
    }
    const b = req.body ?? {};
    const name = String(b.computerName ?? "").trim();
    if (!PC_NAME_RE.test(name)) return res.status(400).json({ success: false, message: "Bad computerName" });
    try {
        const key = `pc:${name.toUpperCase()}`.slice(0, 40);
        const prev = await NetworkSnapshot.findByPk(key);
        let prevData = null;
        try { prevData = prev?.data ? JSON.parse(prev.data) : null; } catch { prevData = null; }
        const data = {
            computerName: name.toUpperCase(),
            fromIp: (req.ip || "").replace(/^::ffff:/, ""),
            user: s(b.user, 150),
            os: {
                caption: s(b.os?.caption, 150),
                version: s(b.os?.version, 40),
                build: s(b.os?.build, 40),
                displayVersion: s(b.os?.displayVersion, 20),
                installDate: s(b.os?.installDate, 40),
                lastBoot: s(b.os?.lastBoot, 40),
            },
            hardware: {
                manufacturer: s(b.hardware?.manufacturer, 100),
                model: s(b.hardware?.model, 100),
                serial: s(b.hardware?.serial, 100),
                ramGb: Number(b.hardware?.ramGb) || null,
                ramFreeGb: num(b.hardware?.ramFreeGb),
                cpu: b.hardware?.cpu ? {
                    name: s(b.hardware.cpu.name, 150),
                    sockets: num(b.hardware.cpu.sockets),
                    cores: num(b.hardware.cpu.cores),
                    threads: num(b.hardware.cpu.threads),
                    loadPct: num(b.hardware.cpu.loadPct),
                } : null,
                volumes: asArray(b.hardware?.volumes).slice(0, 26).map((v) => ({
                    drive: s(v?.drive, 4),
                    label: s(v?.label, 60),
                    fs: s(v?.fs, 10),
                    sizeGb: num(v?.sizeGb),
                    freeGb: num(v?.freeGb),
                })).filter((v) => v.drive),
                disks: asArray(b.hardware?.disks).slice(0, 16).map((d) => ({
                    model: s(d?.model, 100),
                    mediaType: s(d?.mediaType, 20),
                    busType: s(d?.busType, 20),
                    sizeGb: num(d?.sizeGb),
                    health: s(d?.health, 20),
                })),
            },
            windowsLicenses: licenseList(b.windowsLicenses),
            officeLicenses: licenseList(b.officeLicenses),
            officeProducts: asArray(b.officeProducts).slice(0, 40).map((p) => ({
                name: s(p?.name, 200),
                version: s(p?.version, 40),
                source: s(p?.source, 20),
            })),
            clickToRun: b.clickToRun ? {
                productIds: s(b.clickToRun.productIds, 300),
                version: s(b.clickToRun.version, 40),
                platform: s(b.clickToRun.platform, 10),
                channel: s(b.clickToRun.channel, 200),
            } : null,
            nics: asArray(b.nics).slice(0, 10)
                .map((n) => ({ mac: normalizeMac(n?.mac), ip: s(n?.ip, 45) }))
                .filter((n) => n.mac),
            security: securityReport(b.security),
            health: healthReport(b.health),
            win11: win11Report(b.win11),
            // Installed programs (machine-wide), for the software page.
            software: asArray(b.software).slice(0, 800)
                .map((x) => ({
                    name: s(x?.name, 200),
                    version: s(x?.version, 60),
                    publisher: s(x?.publisher, 150),
                    installDate: s(x?.installDate, 20),
                    arch: s(x?.arch, 5),
                }))
                .filter((x) => x.name),
            // Servers only (ProductType 2/3): clock + stopped auto services.
            server: b.server && typeof b.server === "object" ? {
                psVersion: s(b.server.psVersion, 20),
                clientTimeUtc: s(b.server.clientTimeUtc, 40),
                stoppedServices: asArray(b.server.stoppedServices).slice(0, 30).map((x) => ({
                    name: s(x?.name, 100), displayName: s(x?.displayName, 150),
                })),
            } : null,
        };
        await saveSnapshot(key, data);
        alertHealthChange(name.toUpperCase(), prevData,
            prev?.fetchedAt ? new Date(prev.fetchedAt).toISOString() : null, data);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ PC report failed:", err);
        res.status(500).json({ success: false, message: "Report failed" });
    }
});

// ---------------------------------------------------------------------------
// everything below needs a session + it.network
// ---------------------------------------------------------------------------

router.use(authenticateToken, requirePermission(PERMISSIONS.IT_NETWORK));

function sourceInfo(snap) {
    return snap
        ? { fetchedAt: snap.fetchedAt, error: snap.error, errorAt: snap.errorAt }
        : null;
}

// GET /overview -- the status tab: Meraki devices, WAN uplinks, VPN, DHCP
// scopes, monitor summary, device counts and every source's age/error.
router.get("/overview", async (req, res) => {
    try {
        const snaps = await loadSnapshots();
        const networks = snaps.meraki_networks?.data ?? [];
        const networkName = new Map(networks.map((n) => [n.id, n.name]));

        const merakiDevices = (snaps.meraki_devices?.data ?? []).map((d) => ({
            serial: d.serial,
            name: d.name || null,
            model: d.model,
            productType: d.productType,
            status: d.status,
            lanIp: d.lanIp ?? null,
            publicIp: d.publicIp ?? null,
            mac: d.mac ?? null,
            networkName: networkName.get(d.networkId) ?? null,
            lastReportedAt: d.lastReportedAt ?? null,
        }));

        const uplinks = (snaps.meraki_uplinks?.data ?? []).map((u) => ({
            serial: u.serial,
            model: u.model,
            networkName: networkName.get(u.networkId) ?? null,
            lastReportedAt: u.lastReportedAt ?? null,
            uplinks: (u.uplinks ?? []).map((l) => ({
                interface: l.interface,
                status: l.status,
                ip: l.ip ?? null,
                publicIp: l.publicIp ?? null,
                gateway: l.gateway ?? null,
                provider: l.provider ?? null,
            })),
        }));

        const vpn = (snaps.meraki_vpn?.data ?? []).map((v) => ({
            networkName: v.networkName ?? networkName.get(v.networkId) ?? null,
            deviceStatus: v.deviceStatus ?? null,
            merakiPeers: (v.merakiVpnPeers ?? []).map((p) => ({
                networkName: p.networkName ?? networkName.get(p.networkId) ?? null,
                reachability: p.reachability ?? null,
            })),
            thirdPartyPeers: (v.thirdPartyVpnPeers ?? []).map((p) => ({
                name: p.name ?? null,
                publicIp: p.publicIp ?? null,
                reachability: p.reachability ?? null,
            })),
        }));

        const targets = await NetworkMonitorTarget.findAll({ order: [["kind", "ASC"], ["name", "ASC"]] });
        const devices = await buildDeviceList(snaps);

        res.json({
            success: true,
            merakiConfigured: merakiConfigured(),
            ingestConfigured: Boolean(process.env.NETWORK_INGEST_TOKEN),
            sources: Object.fromEntries(
                ["lan_scan", "meraki_devices", "meraki_clients", "meraki_uplinks", "meraki_vpn", "dhcp", "ad",
                    ...Object.keys(snaps).filter((k) => k.startsWith("ad_") || k.startsWith("logons_")).sort()]
                    .map((k) => [k, sourceInfo(snaps[k])]),
            ),
            merakiDevices,
            uplinks,
            vpn,
            dhcpScopes: snaps.dhcp?.data?.scopes ?? [],
            monitor: {
                total: targets.filter((t) => t.enabled).length,
                up: targets.filter((t) => t.enabled && t.status === "up").length,
                down: targets.filter((t) => t.enabled && t.status === "down").length,
                downList: targets.filter((t) => t.enabled && t.status === "down")
                    .map((t) => ({ id: t.id, name: t.name, host: t.host, since: t.lastChangeAt, error: t.lastError })),
            },
            deviceCounts: {
                total: devices.length,
                online: devices.filter((d) => d.online).length,
                wired: devices.filter((d) => d.online && d.connection === "wired").length,
                wireless: devices.filter((d) => d.online && d.connection === "wireless").length,
                adComputers: devices.filter((d) => d.ad).length,
                // On the wire but neither an AD computer nor a DHCP
                // reservation, nor labelled by IT -- worth a look.
                unknown: devices.filter((d) => d.online && !d.ad && !d.reservation && !d.label).length,
                // From the PCs' own reports (POST /report).
                pcReports: devices.filter((d) => d.pc).length,
                windowsNotActivated: devices.filter((d) => d.activation?.windows
                    && d.activation.windows.status !== "activated").length,
                officeNotActivated: devices.filter((d) => d.activation
                    && ["not_activated", "grace", "partial"].includes(d.activation.office.status)).length,
                // From the 2026-11-25 report fields (antivirus + health)
                avReported: devices.filter((d) => d.health?.av).length,
                avProblems: devices.filter((d) => d.health?.av && d.health.av.status !== "ok").length,
                healthProblems: devices.filter((d) => d.health?.issues.length).length,
                healthCritical: devices.filter((d) => d.health?.critical).length,
                // Windows without security updates (Win 10, 7, 8.1, old Win 11 / Server),
                // online now or logged on to AD in the last 60 days
                // Windows 11 upgrade check of PCs not on Windows 11 yet
                win11Ready: devices.filter((d) => d.win11?.status === "ready").length,
                win11Fixable: devices.filter((d) => d.win11?.status === "fixable").length,
                win11No: devices.filter((d) => d.win11?.status === "no").length,
                win11Unknown: devices.filter((d) => d.win11?.status === "unknown").length,
                // (isActiveDevice: not an old AD account whose name still
                // resolves to another machine's IP)
                osUnsupported: devices.filter((d) => d.osSupported === false && isActiveDevice(d)).length,
                // Phones/tablets holding a DHCP lease now (networkInventory
                // classifyDevice); "named" = recognised by host name, the rest
                // are private-MAC devices with no name.
                phones: devices.filter((d) => (d.category === "phone" || d.category === "tablet") && d.dhcp).length,
                phonesNamed: devices.filter((d) => (d.category === "phone" || d.category === "tablet")
                    && d.dhcp && !d.mobile?.guess).length,
            },
        });
    } catch (err) {
        console.error("❌ Network overview failed:", err);
        res.status(500).json({ success: false, message: "Failed to load the network overview" });
    }
});

// IT ops page (admin/it-ops): servers, backups, AD/DNS hygiene, expiries.
router.get("/ops", async (req, res) => {
    try {
        res.json({ success: true, ...(await buildOps()) });
    } catch (err) {
        console.error("❌ IT ops load failed:", err);
        res.status(500).json({ success: false, message: "Failed to load IT operations" });
    }
});

router.post("/ops/certs/refresh", async (req, res) => {
    try {
        const items = await refreshCerts();
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ Certificate check failed:", err);
        res.status(500).json({ success: false, message: "Certificate check failed" });
    }
});

router.get("/devices", async (req, res) => {
    try {
        const items = await buildDeviceList();
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ Network device list failed:", err);
        res.status(500).json({ success: false, message: "Failed to load devices" });
    }
});

const DEVICE_KEY_RE = /^(?:[0-9a-f]{2}(?::[0-9a-f]{2}){5}|ad:[A-Z0-9_.\-$]{1,64}|ip:\d{1,3}(?:\.\d{1,3}){3})$/;

router.patch("/devices/:key/note", async (req, res) => {
    const key = String(req.params.key);
    if (!DEVICE_KEY_RE.test(key)) return res.status(400).json({ success: false, message: "Bad device key" });
    const clean = (v, max) => {
        const t = v === null || v === undefined ? "" : String(v).trim();
        if (t.length > max) throw new Error("Value is too long");
        return t || null;
    };
    try {
        const data = {
            label: clean(req.body?.label, 100),
            owner: clean(req.body?.owner, 100),
            notes: clean(req.body?.notes, 1000),
        };
        if (!data.label && !data.owner && !data.notes) {
            await NetworkDeviceNote.destroy({ where: { deviceKey: key } });
        } else {
            await NetworkDeviceNote.upsert({ deviceKey: key, ...data, updatedByUserId: req.user.userId });
        }
        logAction({ entityId: key, entityLabel: data.label, action: "device_note", changes: data, req });
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// GET /devices/:key/rdp -- a ready .rdp file for the device (Windows). The
// connection itself is made by the viewer's own Remote Desktop client, so
// it only works from inside the network or over VPN, and Windows still asks
// for the device's credentials. Audited.
router.get("/devices/:key/rdp", requirePermission(PERMISSIONS.IT_REMOTE), async (req, res) => {
    const key = String(req.params.key);
    if (!DEVICE_KEY_RE.test(key)) return res.status(400).json({ success: false, message: "Bad device key" });
    try {
        const devices = await buildDeviceList();
        const device = devices.find((d) => d.key === key);
        if (!device) return res.status(404).json({ success: false, message: "Device not found" });
        const address = device.ad?.dnsHostName || device.ip;
        if (!address || !HOST_RE.test(address)) {
            return res.status(400).json({ success: false, message: "This device has no address to connect to" });
        }
        const file = [
            `full address:s:${address}`,
            "prompt for credentials:i:1",
            "administrative session:i:0",
            "screen mode id:i:2",
            "use multimon:i:0",
            "session bpp:i:32",
            "authentication level:i:2",
            "redirectclipboard:i:1",
            "redirectprinters:i:0",
            "redirectdrives:i:0",
            "autoreconnection enabled:i:1",
            "",
        ].join("\r\n");
        const fileName = String(device.name || address).replace(/[^A-Za-z0-9_.-]/g, "_");
        logAction({
            entityId: key,
            entityLabel: device.name || address,
            action: "rdp_download",
            changes: { address },
            req,
        });
        res.setHeader("Content-Type", "application/x-rdp");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}.rdp"`);
        res.send(file);
    } catch (err) {
        console.error("❌ RDP file failed:", err);
        res.status(500).json({ success: false, message: "Failed to build the RDP file" });
    }
});

// GET /devices/:key/mesh -- link that opens this device in MeshCentral
// ("Petra Remote", LAN/VPN only). MeshCentral's own ?gotodevicename= match is
// exact and case-sensitive, so the device id is looked up here instead: read
// MeshCentral's NeDB file on this server and match the Windows name (rname) or
// display name, ignoring case. Read-only. Audited.
const MESH_DB_PATH = process.env.MESH_DB_PATH || "C:\\Petra\\meshcentral\\meshcentral-data\\meshcentral.db";
const MESH_PUBLIC_URL = process.env.MESH_PUBLIC_URL || "https://app.petralu.net:4430/";

async function findMeshNode(names) {
    const wanted = new Set(names.filter(Boolean).map((n) => String(n).toLowerCase()));
    if (!wanted.size) return null;
    const text = await fs.readFile(MESH_DB_PATH, "utf8");
    const nodes = new Map();
    for (const line of text.split("\n")) {
        if (!line.includes('"node/')) continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        if (o.$$deleted) nodes.delete(o._id);
        else if (o.type === "node" && typeof o._id === "string") nodes.set(o._id, o);
    }
    let byName = null;
    for (const n of nodes.values()) {
        if (n.rname && wanted.has(String(n.rname).toLowerCase())) return n;
        if (!byName && n.name && wanted.has(String(n.name).toLowerCase())) byName = n;
    }
    if (byName) return byName;
    // Windows/AD computer names are cut to 15 characters (NetBIOS), while the
    // Mesh agent reports the full host name: AD "ABDULLAHABUSHAW" is Mesh
    // "AbdullahAbushawish". Fall back to the first 15 characters -- only when
    // that picks exactly one device.
    const nb = (s) => String(s).toLowerCase().slice(0, 15);
    const wanted15 = new Set([...wanted].map(nb));
    const hits = [...nodes.values()].filter((n) => (n.rname && wanted15.has(nb(n.rname)))
        || (n.name && wanted15.has(nb(n.name))));
    return hits.length === 1 ? hits[0] : null;
}

router.get("/devices/:key/mesh", requirePermission(PERMISSIONS.IT_REMOTE), async (req, res) => {
    const key = String(req.params.key);
    if (!DEVICE_KEY_RE.test(key)) return res.status(400).json({ success: false, message: "Bad device key" });
    try {
        const devices = await buildDeviceList();
        const device = devices.find((d) => d.key === key);
        if (!device) return res.status(404).json({ success: false, message: "Device not found" });
        const node = await findMeshNode([device.pc?.computerName, device.ad?.name, device.name]);
        if (!node) {
            return res.status(404).json({
                success: false,
                message: "This PC is not in Petra Remote yet (agent not installed)",
            });
        }
        // node ids look like "node//<base64>" (MeshCentral base64: + -> @, / -> $).
        // ?gotonode= takes the part after the domain, but MeshCentral's URL
        // parser drops any value containing "%", so an encoded @/$ is ignored
        // and the page falls back to My Devices. It also accepts the id as 96
        // hex chars, which needs no encoding -- send that. viewmode=10 is the
        // device page; without it the server defaults to 1 (My Devices) and
        // the page opens the device in that view, i.e. the device list.
        //
        // ?mode=view|control opens the Desktop tab (viewmode=11) and adds
        // petra=<mode>; meshcentral-web/public/scripts/custom.js on the app
        // server reads it, sets MeshCentral's "Input" checkbox (off = view only,
        // on = full control) and connects. View only is a viewer setting, not
        // a permission -- the viewer can still tick Input in the session.
        const b64 = node._id.split("/").pop().replaceAll("@", "+").replaceAll("$", "/");
        const id = Buffer.from(b64, "base64").toString("hex");
        // consent = ask the logged-on user (Allow/Deny prompt + session bar)
        const mode = ["view", "control", "consent"].includes(req.query.mode) ? req.query.mode : "page";
        logAction({
            entityId: key,
            entityLabel: node.rname || node.name,
            action: mode === "page" ? "remote_control_open" : `remote_control_${mode}`,
            req,
        });
        res.json({
            success: true,
            name: node.name,
            url:
                mode === "page"
                    ? `${MESH_PUBLIC_URL}?viewmode=10&gotonode=${id}`
                    : `${MESH_PUBLIC_URL}?viewmode=11&gotonode=${id}&petra=${mode}`,
        });
    } catch (err) {
        console.error("❌ Mesh lookup failed:", err);
        res.status(500).json({ success: false, message: "Could not reach Petra Remote" });
    }
});

router.post("/refresh", async (req, res) => {
    try {
        const result = await refreshMerakiNow();
        if (result.ok === false) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Meraki refresh failed:", err);
        res.status(500).json({ success: false, message: "Refresh failed" });
    }
});

// ---------------------------------------------------------------------------
// monitor targets
// ---------------------------------------------------------------------------

function parseTarget(body, partial) {
    const out = {};
    if (body.name !== undefined || !partial) {
        const name = String(body.name ?? "").trim();
        if (!name || name.length > 100) throw new Error("Name is required (max 100 characters)");
        out.name = name;
    }
    if (body.host !== undefined || !partial) {
        const host = String(body.host ?? "").trim();
        if (!HOST_RE.test(host)) throw new Error("Host must be an IP address or host name");
        out.host = host;
    }
    if (body.port !== undefined) {
        if (body.port === null || body.port === "") out.port = null;
        else {
            const port = Number(body.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535");
            out.port = port;
        }
    }
    if (body.kind !== undefined) {
        if (!NETWORK_TARGET_KINDS.includes(body.kind)) throw new Error("Unknown kind");
        out.kind = body.kind;
    }
    if (body.site !== undefined) out.site = String(body.site ?? "").trim().slice(0, 50) || null;
    if (body.notes !== undefined) out.notes = String(body.notes ?? "").trim().slice(0, 500) || null;
    if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
    if (body.notify !== undefined) out.notify = Boolean(body.notify);
    return out;
}

router.get("/targets", async (req, res) => {
    const items = await NetworkMonitorTarget.findAll({ order: [["kind", "ASC"], ["name", "ASC"]] });
    res.json({ success: true, items, kinds: NETWORK_TARGET_KINDS });
});

router.post("/targets", async (req, res) => {
    try {
        const data = parseTarget(req.body ?? {}, false);
        const target = await NetworkMonitorTarget.create({ ...data, createdByUserId: req.user.userId });
        logAction({ entityId: target.id, entityLabel: target.name, action: "target_create", changes: data, req });
        res.json({ success: true, item: target });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

router.patch("/targets/:id", async (req, res) => {
    try {
        const target = await NetworkMonitorTarget.findByPk(req.params.id);
        if (!target) return res.status(404).json({ success: false, message: "Not found" });
        const data = parseTarget(req.body ?? {}, true);
        // A new address/port starts over -- don't keep the old host's state.
        if ((data.host && data.host !== target.host) || (data.port !== undefined && data.port !== target.port)) {
            Object.assign(data, { status: "unknown", consecutiveFails: 0, lastRttMs: null, lastError: null, lastChangeAt: null });
        }
        await target.update(data);
        logAction({ entityId: target.id, entityLabel: target.name, action: "target_update", changes: data, req });
        res.json({ success: true, item: target });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

router.delete("/targets/:id", async (req, res) => {
    const target = await NetworkMonitorTarget.findByPk(req.params.id);
    if (!target) return res.status(404).json({ success: false, message: "Not found" });
    await target.destroy();
    logAction({ entityId: target.id, entityLabel: target.name, action: "target_delete", req });
    res.json({ success: true });
});

// POST /check -- one-off check of any host (the "Test" button in the target
// form, and "Ping" on a device row). Doesn't touch the monitor's state.
router.post("/check", async (req, res) => {
    const host = String(req.body?.host ?? "").trim();
    const port = req.body?.port ? Number(req.body.port) : null;
    if (!HOST_RE.test(host)) return res.status(400).json({ success: false, message: "Bad host" });
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        return res.status(400).json({ success: false, message: "Bad port" });
    }
    const result = await checkHost(host, port);
    res.json({ success: true, ...result });
});

export default router;
