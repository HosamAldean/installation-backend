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
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { NetworkMonitorTarget, NetworkDeviceNote, NETWORK_TARGET_KINDS } from "../models/Network.js";
import { AdminActionAudit } from "../models/AdminActionAudit.js";
import { merakiConfigured } from "../services/merakiClient.js";
import {
    HOST_RE, checkHost, refreshMerakiNow, saveSnapshot,
} from "../services/networkMonitor.js";
import { buildDeviceList, loadSnapshots, normalizeMac } from "../services/networkInventory.js";

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
        const { dhcp, ad, logons } = req.body ?? {};
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
            await saveSnapshot("ad", {
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
            saved.push("ad");
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
        await saveSnapshot(key, {
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
        });
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
                    ...Object.keys(snaps).filter((k) => k.startsWith("logons_")).sort()]
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
            },
        });
    } catch (err) {
        console.error("❌ Network overview failed:", err);
        res.status(500).json({ success: false, message: "Failed to load the network overview" });
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
