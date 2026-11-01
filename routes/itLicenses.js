// backend/routes/itLicenses.js
// IT licenses tracker (models/ItLicense.js) -- domains, SSL, software,
// cloud subscriptions and their renewals. Hardcoded admin-only (not a
// PermissionGrant key), per the user's direction 2026-11-01 ("for the IT
// section just for the admin"). Reminders: services/itLicenseMonitor.js.
import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { ItLicense, IT_LICENSE_CATEGORIES } from "../models/ItLicense.js";
import { ItLicenseRenewal } from "../models/ItLicenseRenewal.js";
import { ItLicenseAttachment } from "../models/ItLicenseAttachment.js";
import { AdminActionAudit } from "../models/AdminActionAudit.js";
import { sequelize2 } from "../config/db.js";
import { ammanToday, daysUntil } from "../services/itLicenseMonitor.js";

const router = express.Router();
router.use(authenticateToken, authorizeRoles("admin"));

// Invoice/receipt files -- same disk-storage + fileFilter pattern as the HR
// leave attachments, but kept OUT of the public /uploads static folder
// (these are invoices) and served only by GET /attachments/:id/file below.
const attachmentsDir = path.resolve(process.cwd(), "private-uploads/it-licenses");
fs.mkdirSync(attachmentsDir, { recursive: true });
const attachmentAllowedExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
const attachmentMimeRegex = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
const attachmentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, attachmentsDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, Date.now() + "-" + Math.random().toString(36).substring(2, 10) + ext);
        },
    }),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (attachmentMimeRegex.test(file.mimetype) && attachmentAllowedExts.has(ext)) {
            return cb(null, true);
        }
        return cb(new Error("Only image (JPG/PNG/WebP) or PDF files are allowed"));
    },
    limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

function removeStoredFiles(names) {
    for (const name of names) {
        fs.promises.unlink(path.join(attachmentsDir, name)).catch(() => {});
    }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FOLLOW_UP_STATUSES = ["none", "in_progress", "waiting_payment"];

// Same fire-and-forget audit as routes/announcements.js.
function logAction({ entityId, entityLabel, action, changes, req }) {
    AdminActionAudit.create({
        module: "it_license",
        entityId: String(entityId),
        entityLabel: entityLabel ?? null,
        action,
        changes: changes ? JSON.stringify(changes) : null,
        performedByUserId: req.user?.userId ?? null,
    }).catch((err) => {
        console.error("❌ Failed to record admin action audit:", err);
    });
}

function withDaysLeft(license, today) {
    const json = license.toJSON();
    return { ...json, daysLeft: daysUntil(json.expiryDate, today) };
}

// Validates and normalises a create/update body. `partial` skips the
// required-field checks for PATCH.
function parseBody(body, partial) {
    const out = {};
    const str = (key, max) => {
        if (body[key] === undefined) return;
        const v = body[key] === null ? "" : String(body[key]).trim();
        if (v.length > max) throw new Error(`${key} is too long`);
        out[key] = v || null;
    };
    str("productName", 200);
    str("vendor", 150);
    str("accountRef", 255);
    str("followUpNote", 500);
    str("notes", 5000);
    if (body.currency !== undefined) {
        const c = body.currency ? String(body.currency).trim().toUpperCase() : null;
        if (c && !/^[A-Z]{3}$/.test(c)) throw new Error("Currency must be a 3-letter code");
        out.currency = c;
    }
    if (body.category !== undefined) {
        if (!IT_LICENSE_CATEGORIES.includes(body.category)) throw new Error("Unknown category");
        out.category = body.category;
    }
    for (const key of ["purchaseDate", "expiryDate"]) {
        if (body[key] === undefined) continue;
        if (body[key] === null || body[key] === "") {
            out[key] = null;
        } else if (!DATE_RE.test(body[key]) || Number.isNaN(Date.parse(body[key]))) {
            throw new Error(`${key} must be a date (YYYY-MM-DD)`);
        } else {
            out[key] = body[key];
        }
    }
    if (body.seats !== undefined) {
        const n = body.seats === null || body.seats === "" ? null : Number(body.seats);
        if (n !== null && (!Number.isInteger(n) || n < 0)) throw new Error("Seats must be a whole number");
        out.seats = n;
    }
    if (body.cost !== undefined) {
        const n = body.cost === null || body.cost === "" ? null : Number(body.cost);
        if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error("Cost must be a positive number");
        out.cost = n;
    }
    if (body.remindDaysBefore !== undefined) {
        const n = Number(body.remindDaysBefore);
        if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error("Reminder days must be 0-365");
        out.remindDaysBefore = n;
    }
    if (body.autoRenew !== undefined) out.autoRenew = Boolean(body.autoRenew);
    if (body.status !== undefined) {
        if (!["active", "cancelled"].includes(body.status)) throw new Error("Unknown status");
        out.status = body.status;
    }
    if (body.followUpStatus !== undefined) {
        if (!FOLLOW_UP_STATUSES.includes(body.followUpStatus)) throw new Error("Unknown follow-up status");
        out.followUpStatus = body.followUpStatus;
    }
    if (!partial) {
        if (!out.productName) throw new Error("Product name is required");
        if (!out.expiryDate) throw new Error("Expiry date is required");
    } else if ("productName" in out && !out.productName) {
        throw new Error("Product name is required");
    } else if ("expiryDate" in out && !out.expiryDate) {
        throw new Error("Expiry date is required");
    }
    return out;
}

// GET / -- every license with daysLeft (negative = expired), soonest first.
router.get("/", async (req, res) => {
    try {
        const today = ammanToday();
        const rows = await ItLicense.findAll({ order: [["expiryDate", "ASC"], ["id", "ASC"]] });
        const counts = await ItLicenseAttachment.count({ group: ["licenseId"] });
        const countBy = new Map(counts.map((c) => [c.licenseId, Number(c.count)]));
        res.json({
            success: true,
            today,
            items: rows.map((r) => ({ ...withDaysLeft(r, today), attachmentCount: countBy.get(r.id) ?? 0 })),
        });
    } catch (err) {
        console.error("❌ IT LICENSES LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load licenses" });
    }
});

router.post("/", async (req, res) => {
    let data;
    try {
        data = parseBody(req.body ?? {}, false);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
    try {
        const license = await ItLicense.create({
            ...data,
            createdByUserId: req.user.userId,
            updatedByUserId: req.user.userId,
        });
        logAction({ entityId: license.id, entityLabel: license.productName, action: "create", changes: data, req });
        res.status(201).json({ success: true, item: withDaysLeft(license, ammanToday()) });
    } catch (err) {
        console.error("❌ IT LICENSE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to add license" });
    }
});

router.patch("/:id", async (req, res) => {
    let data;
    try {
        data = parseBody(req.body ?? {}, true);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
    try {
        const license = await ItLicense.findByPk(req.params.id);
        if (!license) return res.status(404).json({ success: false, message: "License not found" });
        // A new expiry date (or reminder window) restarts the reminders.
        if ((data.expiryDate && data.expiryDate !== license.expiryDate)
            || (data.remindDaysBefore !== undefined && data.remindDaysBefore !== license.remindDaysBefore)) {
            data.lastReminderDays = null;
            data.lastReminderAt = null;
        }
        await license.update({ ...data, updatedByUserId: req.user.userId });
        logAction({ entityId: license.id, entityLabel: license.productName, action: "update", changes: req.body, req });
        res.json({ success: true, item: withDaysLeft(license, ammanToday()) });
    } catch (err) {
        console.error("❌ IT LICENSE UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update license" });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        const license = await ItLicense.findByPk(req.params.id);
        if (!license) return res.status(404).json({ success: false, message: "License not found" });
        const attachments = await ItLicenseAttachment.findAll({ where: { licenseId: license.id } });
        await sequelize2.transaction(async (t) => {
            await ItLicenseAttachment.destroy({ where: { licenseId: license.id }, transaction: t });
            await ItLicenseRenewal.destroy({ where: { licenseId: license.id }, transaction: t });
            await license.destroy({ transaction: t });
        });
        removeStoredFiles(attachments.map((a) => a.storedName));
        logAction({ entityId: license.id, entityLabel: license.productName, action: "delete", req });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IT LICENSE DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete license" });
    }
});

// POST /:id/renew -- moves the expiry date forward, records the renewal,
// clears the follow-up and restarts the reminders.
router.post("/:id/renew", async (req, res) => {
    const { newExpiryDate, renewedOn, cost, currency, notes } = req.body ?? {};
    if (!DATE_RE.test(newExpiryDate ?? "") || Number.isNaN(Date.parse(newExpiryDate))) {
        return res.status(400).json({ success: false, message: "New expiry date is required" });
    }
    if (renewedOn && (!DATE_RE.test(renewedOn) || Number.isNaN(Date.parse(renewedOn)))) {
        return res.status(400).json({ success: false, message: "Renewal date must be a date (YYYY-MM-DD)" });
    }
    const costNum = cost === undefined || cost === null || cost === "" ? null : Number(cost);
    if (costNum !== null && (!Number.isFinite(costNum) || costNum < 0)) {
        return res.status(400).json({ success: false, message: "Cost must be a positive number" });
    }
    const cur = currency ? String(currency).trim().toUpperCase() : null;
    if (cur && !/^[A-Z]{3}$/.test(cur)) {
        return res.status(400).json({ success: false, message: "Currency must be a 3-letter code" });
    }
    try {
        const license = await ItLicense.findByPk(req.params.id);
        if (!license) return res.status(404).json({ success: false, message: "License not found" });
        if (newExpiryDate <= license.expiryDate) {
            return res.status(400).json({ success: false, message: "New expiry date must be after the current one" });
        }
        let renewal;
        await sequelize2.transaction(async (t) => {
            renewal = await ItLicenseRenewal.create({
                licenseId: license.id,
                renewedOn: renewedOn || ammanToday(),
                previousExpiryDate: license.expiryDate,
                newExpiryDate,
                cost: costNum,
                currency: cur ?? license.currency,
                notes: notes ? String(notes).trim().slice(0, 500) : null,
                renewedByUserId: req.user.userId,
            }, { transaction: t });
            await license.update({
                expiryDate: newExpiryDate,
                ...(costNum !== null ? { cost: costNum } : {}),
                ...(cur ? { currency: cur } : {}),
                status: "active",
                followUpStatus: "none",
                followUpNote: null,
                lastReminderDays: null,
                lastReminderAt: null,
                updatedByUserId: req.user.userId,
            }, { transaction: t });
        });
        logAction({
            entityId: license.id,
            entityLabel: license.productName,
            action: "renew",
            changes: { newExpiryDate, cost: costNum, currency: cur },
            req,
        });
        res.json({ success: true, item: withDaysLeft(license, ammanToday()), renewalId: renewal.id });
    } catch (err) {
        console.error("❌ IT LICENSE RENEW ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to renew license" });
    }
});

router.get("/:id/renewals", async (req, res) => {
    try {
        const items = await ItLicenseRenewal.findAll({
            where: { licenseId: req.params.id },
            order: [["renewedOn", "DESC"], ["id", "DESC"]],
        });
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ IT LICENSE RENEWALS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load renewal history" });
    }
});

// GET /:id/attachments -- the license's files; renewalId null = purchase.
router.get("/:id/attachments", async (req, res) => {
    try {
        const items = await ItLicenseAttachment.findAll({
            where: { licenseId: req.params.id },
            order: [["createdAt", "DESC"], ["id", "DESC"]],
        });
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ IT LICENSE ATTACHMENTS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load files" });
    }
});

// POST /:id/attachments (multipart "files", optional "renewalId") --
// purchase invoice when renewalId is empty, else that renewal's invoice.
router.post("/:id/attachments", (req, res, next) => {
    attachmentUpload.array("files", 10)(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    const files = req.files ?? [];
    const storedNames = files.map((f) => f.filename);
    try {
        if (files.length === 0) return res.status(400).json({ success: false, message: "No file uploaded" });
        const license = await ItLicense.findByPk(req.params.id);
        if (!license) {
            removeStoredFiles(storedNames);
            return res.status(404).json({ success: false, message: "License not found" });
        }
        let renewalId = null;
        if (req.body.renewalId) {
            const renewal = await ItLicenseRenewal.findOne({
                where: { id: Number(req.body.renewalId), licenseId: license.id },
            });
            if (!renewal) {
                removeStoredFiles(storedNames);
                return res.status(400).json({ success: false, message: "Renewal not found for this license" });
            }
            renewalId = renewal.id;
        }
        const items = await ItLicenseAttachment.bulkCreate(files.map((f) => ({
            licenseId: license.id,
            renewalId,
            // multer decodes multipart filenames as latin1; Arabic names need utf8.
            fileName: Buffer.from(f.originalname, "latin1").toString("utf8").slice(0, 255),
            storedName: f.filename,
            mimeType: f.mimetype,
            sizeBytes: f.size,
            uploadedByUserId: req.user.userId,
        })));
        logAction({
            entityId: license.id,
            entityLabel: license.productName,
            action: "attach",
            changes: { renewalId, files: items.map((i) => i.fileName) },
            req,
        });
        res.status(201).json({ success: true, items });
    } catch (err) {
        removeStoredFiles(storedNames);
        console.error("❌ IT LICENSE ATTACH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to save files" });
    }
});

// GET /attachments/:attId/file -- streams the file inline (admin only).
router.get("/attachments/:attId/file", async (req, res) => {
    try {
        const att = await ItLicenseAttachment.findByPk(req.params.attId);
        if (!att) return res.status(404).json({ success: false, message: "File not found" });
        const filePath = path.join(attachmentsDir, path.basename(att.storedName));
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: "File is missing on the server" });
        res.setHeader("Content-Type", att.mimeType);
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(att.fileName)}`);
        res.setHeader("Cache-Control", "private, no-store");
        res.sendFile(filePath);
    } catch (err) {
        console.error("❌ IT LICENSE FILE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to open file" });
    }
});

router.delete("/attachments/:attId", async (req, res) => {
    try {
        const att = await ItLicenseAttachment.findByPk(req.params.attId);
        if (!att) return res.status(404).json({ success: false, message: "File not found" });
        await att.destroy();
        removeStoredFiles([att.storedName]);
        logAction({ entityId: att.licenseId, entityLabel: att.fileName, action: "detach", req });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IT LICENSE DETACH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete file" });
    }
});

export default router;
