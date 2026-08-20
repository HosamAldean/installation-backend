// backend/routes/scanAuditLog.js
// Append-only server-side scan log backing ScanAuditTrail.tsx. No update or
// delete endpoint exists here on purpose -- once written, a scan event is
// not user-editable, which is the point (see the model's own comment).
import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { ScanAuditLog } from "../models/ScanAuditLog.js";

const router = express.Router();

// POST /api/scan-audit-log  { barcode, status, projectNo, projectName, hireNote, timestamp }
router.post("/", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const { barcode, status, projectNo, projectName, hireNote, timestamp } = req.body || {};
        if (!barcode || !String(barcode).trim()) {
            return res.status(400).json({ success: false, message: "barcode is required" });
        }
        if (!["OK", "PROJECT_MISMATCH", "NOT_FOUND"].includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const created = await ScanAuditLog.create({
            userId: req.user.userId,
            barcode: String(barcode).trim(),
            status,
            projectNo: projectNo || null,
            projectName: projectName || null,
            hireNote: hireNote || null,
            scannedAt: timestamp ? new Date(timestamp) : new Date(),
            createdAt: new Date(),
        });

        res.json({ success: true, data: { id: created.id } });
    } catch (err) {
        console.error("SCAN AUDIT LOG CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record scan" });
    }
});

// GET /api/scan-audit-log/mine -- the caller's own scan history, most recent first
router.get("/mine", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const logs = await ScanAuditLog.findAll({
            where: { userId: req.user.userId },
            order: [["scannedAt", "DESC"]],
            limit: 500,
        });
        res.json({ success: true, logs });
    } catch (err) {
        console.error("SCAN AUDIT LOG LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load scan history" });
    }
});

export default router;
