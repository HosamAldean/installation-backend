// backend/routes/followUpNotes.js
// Manager/PM follow-up notes — each note is attached to a specific
// worker-reported issue (instOrderStepUpdates row with status='issue').
// Listing happens through /follow-up/reports/issues, which merges each
// issue with its linked note; this file only handles create/resolve/delete.
import express from "express";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { FollowUpNotes } from "../models/index.js";

const router = express.Router();

// POST /api/follow-up-notes  { issueId, note }
router.post("/", authenticateToken, authorizeRoles("installation_manager", "admin"), async (req, res) => {
    try {
        const { issueId, note } = req.body || {};
        if (!issueId) {
            return res.status(400).json({ success: false, message: "issueId is required" });
        }
        if (!note || !String(note).trim()) {
            return res.status(400).json({ success: false, message: "Note text is required" });
        }

        const existing = await FollowUpNotes.findOne({ where: { issueId } });
        if (existing) {
            return res.status(409).json({ success: false, message: "A follow-up note already exists for this issue" });
        }

        const created = await FollowUpNotes.create({
            issueId: Number(issueId),
            note: String(note).trim(),
            createdBy: req.user.userId,
            resolved: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        res.json({ success: true, data: { id: created.id } });
    } catch (err) {
        console.error("FOLLOW-UP NOTES CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create follow-up note" });
    }
});

// PATCH /api/follow-up-notes/:id/resolve  { resolved: true|false }
router.patch("/:id/resolve", authenticateToken, authorizeRoles("installation_manager", "admin"), async (req, res) => {
    try {
        const note = await FollowUpNotes.findByPk(req.params.id);
        if (!note) return res.status(404).json({ success: false, message: "Note not found" });

        const resolved = !!req.body?.resolved;
        note.resolved = resolved;
        note.resolvedBy = resolved ? req.user.userId : null;
        note.resolvedAt = resolved ? new Date() : null;
        note.updatedAt = new Date();
        await note.save();

        res.json({ success: true });
    } catch (err) {
        console.error("FOLLOW-UP NOTES RESOLVE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update follow-up note" });
    }
});

// DELETE /api/follow-up-notes/:id
router.delete("/:id", authenticateToken, authorizeRoles("installation_manager", "admin"), async (req, res) => {
    try {
        const deleted = await FollowUpNotes.destroy({ where: { id: req.params.id } });
        if (!deleted) return res.status(404).json({ success: false, message: "Note not found" });
        res.json({ success: true });
    } catch (err) {
        console.error("FOLLOW-UP NOTES DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete follow-up note" });
    }
});

export default router;
