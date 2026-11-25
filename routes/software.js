// backend/routes/software.js
// IT software library + installed-software inventory (frontend
// admin/ItSoftware.tsx), 2026-11-25. Gated by PERMISSIONS.IT_SOFTWARE.
// Phase 1 is read-only towards PCs: it catalogues approved software and
// shows what the PC reports say is installed. Nothing is installed from here.
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { SoftwareLibraryItem, SOFTWARE_CATEGORIES } from "../models/SoftwareLibrary.js";
import { ItLicense } from "../models/ItLicense.js";
import { groupInstalled, loadInstalled, matchLibraryItem } from "../services/softwareInventory.js";

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
        const [items, licenses, inv] = await Promise.all([
            SoftwareLibraryItem.findAll({ order: [["name", "ASC"]], raw: true }),
            ItLicense.findAll({ attributes: ["id", "productName", "seats", "expiryDate", "status"], order: [["productName", "ASC"]], raw: true }),
            loadInstalled(),
        ]);
        const byId = new Map(licenses.map((l) => [l.id, l]));
        res.json({
            success: true,
            categories: SOFTWARE_CATEGORIES,
            licenses,
            machinesWithSoftware: inv.machines.length,
            machinesReporting: inv.reporting,
            items: items.map((it) => ({
                ...it,
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
