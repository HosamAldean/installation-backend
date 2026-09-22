// backend/routes/announcements.js
// Admin-broadcast in-app banners (see models/Announcement.js). GET /active
// is for every logged-in user (the global banner mounted in
// ProtectedRoute); everything else is admin-only management, hardcoded
// (not a PermissionGrant key) -- a system-wide broadcast is high-blast-
// radius, same reasoning as Lookups/Permissions staying hardcoded
// admin-only rather than delegable.
import express from "express";
import { Op } from "sequelize";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { Announcement } from "../models/Announcement.js";
import { AdminActionAudit } from "../models/AdminActionAudit.js";

const router = express.Router();

function truncate(text, max = 80) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Fire-and-forget, same reasoning as routes/lookups.js's logLookupAction --
// a logging failure must never affect the actual write it's describing.
function logAnnouncementAction({ entityId, entityLabel, action, changes, req }) {
    AdminActionAudit.create({
        module: "announcement",
        entityId: String(entityId),
        entityLabel: entityLabel ?? null,
        action,
        changes: changes ? JSON.stringify(changes) : null,
        performedByUserId: req.user?.userId ?? null,
    }).catch((err) => {
        console.error("❌ Failed to record admin action audit:", err);
    });
}

// ============================================================
// GET /active -- announcements visible to the logged-in caller: active,
// not expired, and either global (targetRole null) or matching their role.
// ============================================================
router.get("/active", authenticateToken, async (req, res) => {
    try {
        const rows = await Announcement.findAll({
            where: {
                active: true,
                [Op.or]: [{ targetRole: null }, { targetRole: req.user.role }],
            },
            order: [["createdAt", "DESC"]],
        });
        // Expiry checked in JS rather than in the query -- keeps the query's
        // only Op.or clause simple (role match) instead of ANDing a second
        // Op.or (expiresAt IS NULL OR expiresAt > now) alongside it.
        const now = new Date();
        const items = rows.filter((r) => !r.expiresAt || new Date(r.expiresAt) > now);
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ ANNOUNCEMENTS ACTIVE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch announcements" });
    }
});

// ============================================================
// GET / -- full list (active and inactive) for the admin management page.
// ============================================================
router.get("/", authenticateToken, authorizeRoles("admin"), async (req, res) => {
    try {
        const items = await Announcement.findAll({ order: [["createdAt", "DESC"]] });
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ ANNOUNCEMENTS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch announcements" });
    }
});

// ============================================================
// POST / -- create a new announcement.
// ============================================================
router.post("/", authenticateToken, authorizeRoles("admin"), async (req, res) => {
    try {
        const { message, severity, targetRole, expiresAt } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: "message is required" });
        }
        const row = await Announcement.create({
            message: String(message).trim(),
            severity: ["info", "warning", "critical"].includes(severity) ? severity : "info",
            targetRole: targetRole || null,
            expiresAt: expiresAt || null,
            createdByUserId: req.user.userId,
        });
        logAnnouncementAction({
            entityId: row.id,
            entityLabel: truncate(row.message),
            action: "created",
            changes: { message: row.message, severity: row.severity, targetRole: row.targetRole, expiresAt: row.expiresAt },
            req,
        });
        res.status(201).json({ success: true, item: row });
    } catch (err) {
        console.error("❌ ANNOUNCEMENT CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create announcement" });
    }
});

// ============================================================
// PATCH /:id -- edit fields and/or toggle active (retract without
// deleting -- see model comment).
// ============================================================
router.patch("/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
    try {
        const row = await Announcement.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });

        const { message, severity, targetRole, expiresAt, active } = req.body;
        const updates = {};
        if (message !== undefined) updates.message = String(message).trim();
        if (severity !== undefined) updates.severity = severity;
        if (targetRole !== undefined) updates.targetRole = targetRole || null;
        if (expiresAt !== undefined) updates.expiresAt = expiresAt || null;
        if (active !== undefined) updates.active = !!active;

        await row.update(updates);
        logAnnouncementAction({
            entityId: row.id,
            entityLabel: truncate(row.message),
            action: "updated",
            changes: updates,
            req,
        });
        res.json({ success: true, item: row });
    } catch (err) {
        console.error("❌ ANNOUNCEMENT UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update announcement" });
    }
});

// ============================================================
// DELETE /:id -- permanent delete (use PATCH active=false for a soft
// retract that keeps history instead).
// ============================================================
router.delete("/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
    try {
        const row = await Announcement.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });
        const entityLabel = truncate(row.message);
        await row.destroy();
        logAnnouncementAction({ entityId: req.params.id, entityLabel, action: "deleted", req });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ ANNOUNCEMENT DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete announcement" });
    }
});

export default router;
