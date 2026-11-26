// backend/routes/software.js
// IT software library + installed-software inventory (frontend
// admin/ItSoftware.tsx), 2026-11-25. Gated by PERMISSIONS.IT_SOFTWARE.
// Phase 1 catalogues approved software and shows what the PC reports say is
// installed. Phase 2 (2026-11-26, /deploy, needs it.software.deploy too)
// queues installs that PCs pick up with their next report -- see
// services/softwareDeploy.js for the safety checks.
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { SoftwareLibraryItem, SOFTWARE_CATEGORIES } from "../models/SoftwareLibrary.js";
import { ItLicense } from "../models/ItLicense.js";
import { groupInstalled, loadInstalled, matchLibraryItem } from "../services/softwareInventory.js";
import { NetworkSnapshot } from "../models/Network.js";
import { loadSnapshots } from "../services/networkInventory.js";
import { deployBlocker, listJobs } from "../services/softwareDeploy.js";
import { SoftwareDeployJob } from "../models/SoftwareDeployJob.js";

// Installers found in the IT software share by its hourly scanner.
async function loadShare() {
    const row = await NetworkSnapshot.findByPk("software_share");
    let data = null;
    try { data = row?.data ? JSON.parse(row.data) : null; } catch { data = null; }
    return { root: data?.root ?? null, files: data?.files ?? [], scannedAt: row?.fetchedAt ?? null };
}

// Library item vs the share: is the installer still there, unchanged?
function installerState(item, share) {
    if (!item.installerPath) return null;
    const f = share.files.find((x) => x.path.toLowerCase() === item.installerPath.toLowerCase());
    if (!f) {
        const onShare = share.root && item.installerPath.toLowerCase().startsWith(share.root.toLowerCase());
        return { found: false, onShare: Boolean(onShare) };
    }
    return {
        found: true,
        onShare: true,
        sizeMb: f.sizeMb,
        fileVersion: f.version,
        hashMatches: item.sha256 ? item.sha256 === f.sha256 : null,
    };
}

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.IT_SOFTWARE));

const str = (v, max) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = String(v).trim();
    return t ? t.slice(0, max) : null;
};

function parseBody(body, partial) {
    const b = body ?? {};
    const data = {
        name: str(b.name, 200),
        vendor: str(b.vendor, 150),
        category: b.category === undefined ? undefined : SOFTWARE_CATEGORIES.includes(b.category) ? b.category : "other",
        version: str(b.version, 60),
        matchPattern: str(b.matchPattern, 200),
        installerPath: str(b.installerPath, 500),
        installArgs: str(b.installArgs, 500),
        sha256: b.sha256 === undefined ? undefined : str(b.sha256, 64)?.toLowerCase() ?? null,
        licenseId: b.licenseId === undefined ? undefined : Number.parseInt(b.licenseId, 10) || null,
        status: b.status === undefined ? undefined : b.status === "retired" ? "retired" : "active",
        notes: str(b.notes, 5000),
    };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    if (!partial || "name" in data) {
        if (!data.name) return { error: "Name is required" };
    }
    if (!partial || "matchPattern" in data) {
        if (!data.matchPattern) data.matchPattern = data.name;
        if (!data.matchPattern) return { error: "Match text is required" };
    }
    if (data.sha256 && !/^[0-9a-f]{64}$/.test(data.sha256)) return { error: "SHA-256 must be 64 hex characters" };
    return { data };
}

// GET /library -- items with where they are installed, plus the IT licenses
// to pick from (so this page doesn't need it.licenses).
router.get("/library", async (req, res) => {
    try {
        const [items, licenses, inv, share] = await Promise.all([
            SoftwareLibraryItem.findAll({ order: [["name", "ASC"]], raw: true }),
            ItLicense.findAll({ attributes: ["id", "productName", "seats", "expiryDate", "status"], order: [["productName", "ASC"]], raw: true }),
            loadInstalled(),
            loadShare(),
        ]);
        const byId = new Map(licenses.map((l) => [l.id, l]));
        res.json({
            success: true,
            categories: SOFTWARE_CATEGORIES,
            licenses,
            machinesWithSoftware: inv.machines.length,
            machinesReporting: inv.reporting,
            share,
            items: items.map((it) => ({
                ...it,
                installer: installerState(it, share),
                deployBlocker: deployBlocker(it, share),
                license: it.licenseId ? byId.get(it.licenseId) ?? null : null,
                ...matchLibraryItem(it, inv.machines, byId.get(it.licenseId)),
            })),
        });
    } catch (err) {
        console.error("❌ Software library load failed:", err);
        res.status(500).json({ success: false, message: "Failed to load the software library" });
    }
});

router.post("/library", async (req, res) => {
    const { data, error } = parseBody(req.body, false);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
        const item = await SoftwareLibraryItem.create({
            ...data,
            createdByUserId: req.user?.userId ?? null,
            updatedByUserId: req.user?.userId ?? null,
        });
        res.status(201).json({ success: true, item });
    } catch (err) {
        console.error("❌ Software library create failed:", err);
        res.status(500).json({ success: false, message: "Failed to add the software" });
    }
});

router.patch("/library/:id", async (req, res) => {
    const { data, error } = parseBody(req.body, true);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
        const item = await SoftwareLibraryItem.findByPk(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: "Not found" });
        await item.update({ ...data, updatedByUserId: req.user?.userId ?? null });
        res.json({ success: true, item });
    } catch (err) {
        console.error("❌ Software library update failed:", err);
        res.status(500).json({ success: false, message: "Failed to update the software" });
    }
});

router.delete("/library/:id", async (req, res) => {
    try {
        const item = await SoftwareLibraryItem.findByPk(req.params.id);
        if (!item) return res.status(404).json({ success: false, message: "Not found" });
        await item.destroy();
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Software library delete failed:", err);
        res.status(500).json({ success: false, message: "Failed to delete the software" });
    }
});

// --- Phase 2: install from the app -------------------------------------

// GET /deploy/targets?itemId= -- PCs that report, to pick install targets;
// with itemId, whether each already has the item (and its version).
router.get("/deploy/targets", async (req, res) => {
    try {
        const snaps = await loadSnapshots();
        const item = req.query.itemId ? await SoftwareLibraryItem.findByPk(req.query.itemId, { raw: true }) : null;
        const inv = item ? await loadInstalled(snaps) : null;
        const have = new Map();
        if (item) for (const p of matchLibraryItem(item, inv.machines, null).pcs) have.set(p.pc, p.version ?? "?");
        const pcs = [];
        for (const [key, snap] of Object.entries(snaps)) {
            if (!key.startsWith("pc:") || !snap?.data?.computerName) continue;
            const d = snap.data;
            pcs.push({
                name: d.computerName,
                user: d.user ?? null,
                os: d.os?.caption ?? null,
                server: Boolean(d.server),
                reportedAt: snap.fetchedAt ? new Date(snap.fetchedAt).toISOString() : null,
                installedVersion: have.get(d.computerName) ?? null,
            });
        }
        pcs.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, pcs });
    } catch (err) {
        console.error("❌ Deploy targets failed:", err);
        res.status(500).json({ success: false, message: "Failed to load PCs" });
    }
});

// GET /deploy?itemId=&pc= -- install jobs, newest first.
router.get("/deploy", async (req, res) => {
    try {
        const jobs = await listJobs({
            itemId: Number.parseInt(req.query.itemId, 10) || undefined,
            computerName: req.query.pc ? String(req.query.pc).slice(0, 63) : undefined,
        });
        res.json({ success: true, jobs });
    } catch (err) {
        console.error("❌ Deploy jobs load failed:", err);
        res.status(500).json({ success: false, message: "Failed to load install jobs" });
    }
});

// POST /deploy { itemId, computers: [...] } -- queue installs.
router.post("/deploy", requirePermission(PERMISSIONS.IT_SOFTWARE_DEPLOY), async (req, res) => {
    try {
        const item = await SoftwareLibraryItem.findByPk(req.body?.itemId, { raw: true });
        const blocker = deployBlocker(item, await loadShare());
        if (blocker) return res.status(400).json({ success: false, message: blocker });
        const wanted = [...new Set((Array.isArray(req.body?.computers) ? req.body.computers : [])
            .map((c) => String(c ?? "").trim().toUpperCase())
            .filter((c) => /^[A-Z0-9][A-Z0-9_-]{0,62}$/.test(c)))].slice(0, 200);
        if (!wanted.length) return res.status(400).json({ success: false, message: "Pick at least one PC" });
        const snaps = await loadSnapshots();
        const known = wanted.filter((c) => snaps[`pc:${c}`.slice(0, 40)]);
        const open = await SoftwareDeployJob.findAll({
            where: { itemId: item.id, computerName: known, status: ["pending", "sent"] },
            attributes: ["computerName"], raw: true,
        });
        const busy = new Set(open.map((j) => j.computerName));
        const queue = known.filter((c) => !busy.has(c));
        await SoftwareDeployJob.bulkCreate(queue.map((c) => ({
            itemId: item.id,
            itemName: item.version ? `${item.name} ${item.version}` : item.name,
            computerName: c,
            installerPath: item.installerPath,
            sha256: item.sha256,
            installArgs: item.installArgs,
            requestedByUserId: req.user?.userId ?? null,
        })));
        res.status(201).json({
            success: true,
            queued: queue,
            alreadyQueued: [...busy],
            unknown: wanted.filter((c) => !known.includes(c)),
        });
    } catch (err) {
        console.error("❌ Deploy queue failed:", err);
        res.status(500).json({ success: false, message: "Failed to queue the install" });
    }
});

// POST /deploy/:id/cancel -- only while the PC has not picked it up.
router.post("/deploy/:id/cancel", requirePermission(PERMISSIONS.IT_SOFTWARE_DEPLOY), async (req, res) => {
    try {
        const [n] = await SoftwareDeployJob.update(
            { status: "cancelled", finishedAt: new Date(), cancelledByUserId: req.user?.userId ?? null },
            { where: { id: req.params.id, status: "pending" } },
        );
        if (!n) return res.status(409).json({ success: false, message: "Only a waiting install can be cancelled" });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Deploy cancel failed:", err);
        res.status(500).json({ success: false, message: "Failed to cancel" });
    }
});

// GET /inventory -- every installed program across the reporting PCs.
router.get("/inventory", async (req, res) => {
    try {
        const inv = await loadInstalled();
        res.json({
            success: true,
            machinesReporting: inv.reporting,
            machinesWithSoftware: inv.machines.length,
            groups: groupInstalled(inv.machines),
        });
    } catch (err) {
        console.error("❌ Software inventory failed:", err);
        res.status(500).json({ success: false, message: "Failed to load installed software" });
    }
});

// GET /pcs/:name -- one machine's installed programs.
router.get("/pcs/:name", async (req, res) => {
    try {
        const name = String(req.params.name).toUpperCase();
        const inv = await loadInstalled();
        const m = inv.machines.find((x) => String(x.name).toUpperCase() === name);
        if (!m) return res.status(404).json({ success: false, message: "No software list from this PC yet" });
        res.json({ success: true, ...m, software: [...m.software].sort((a, b) => String(a.name).localeCompare(String(b.name))) });
    } catch (err) {
        console.error("❌ PC software load failed:", err);
        res.status(500).json({ success: false, message: "Failed to load the PC's software" });
    }
});

export default router;
