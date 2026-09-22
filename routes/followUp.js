//backend/routes/followUp.js
import express from "express";
import { sequelize, sequelize2, sequelizeUtf8, withSqlRetry } from "../config/db.js";
import { QueryTypes } from "sequelize";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { InstOrderStepUpdates, User, FollowUpNotes } from '../models/index.js';
import { notifyOrderUpdate } from './instOrders.js';
import { recordComponentAction, getUnitCompletionStats, markUnitComplete, normalizeUnitNo, registerMaterialScan, pauseMaterialScan, resumeMaterialScan } from '../services/instOrderComponents.js';
import { selfAssignUnit } from '../services/selfAssignUnit.js';
import { ProjectMapCache } from '../models/ProjectMapCache.js';
import { isShortMapLink, extractCoords } from '../services/resolveMapLink.js';

const router = express.Router();
/* ===============================================================
   GLOBAL NO-CACHE (FIXES 304 + STALE UI)
================================================================ */
router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});
/* ===============================================================
   MULTER
================================================================ */
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = req.path.includes("issue") ? "issues" : "photos";
        const dir = path.join(process.cwd(), "uploads", "steps", folder);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const deliveryPhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(process.cwd(), "uploads", "deliveries");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const uploadDeliveryPhoto = multer({ storage: deliveryPhotoStorage });

/* ===============================================================
   HELPERS
================================================================ */
const fixArabic = (str) => {
    if (!str || typeof str !== "string") return str;
    try {
        const buf = Buffer.from(str, "binary");
        const utf = buf.toString("utf8");
        return /[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي]/.test(utf) ? utf : str;
    } catch {
        return str;
    }
};
const fixArabic1 = (text) => {
    if (!text) return null;
    return Buffer.from(text, "latin1").toString("utf8");
};

const normalizeProjectNo = (value) =>
    String(value || '')
        .replace(/\s+/g, '')
        .split('-')[0]
        .replace(/\.0$/, '')
        .trim()
        .toUpperCase();

const safeArabic = (text) => {
    if (!text) return null;
    try {
        return fixArabic(text);
    } catch {
        return text;
    }
};

/* ===============================================================
   GET MY ORDERS (MULTI TEAM + LEADER SUPPORT)
================================================================ */
// GET /api/follow-up/my-orders
// GET /api/follow-up/my-orders
router.get('/my-orders', authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const assignedEmpNo = req.user.assignedEmpNo; // make sure this exists on req.user

        const itemsRaw = await sequelize.query(
            `
    SELECT
       io.id AS instOrderId,
       io.order_number,
       p.projectNo,
       p.projectName,
       iod.id AS instOrderItemId,
       iod.instReqDetId,
       iod.rowId,
       iod.itemName,
       ms.unitIdContract,
       COALESCE(ms.unitIdDetail, iod.unitNo) As unitNo,
       iod.height,
       iod.width,
       ira.teamId
   FROM IIT_Petra.instOrderItems iod
   LEFT JOIN IIT_Petra.masterControl ms ON ms.rowId = iod.rowId
   LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
   LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
   LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
   LEFT JOIN IIT_Petra.instReqAssignments ira
       ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
    WHERE ira.assignedEmpNo = :assignedEmpNo
    ORDER BY io.id DESC, iod.id ASC
    `,
            { replacements: { assignedEmpNo }, type: sequelize.QueryTypes.SELECT }
        );


        if (!itemsRaw.length) {
            return res.json({ success: true, data: { orders: {} } });
        }

        // Fix Arabic names
        const items = itemsRaw.map(r => ({
            ...r,
            itemName: fixArabic(r.itemName),
            projectName: fixArabic(r.projectName)
        }));

        const itemIds = items.map(i => i.instOrderItemId);

        // Fetch steps
        let steps = [];
        if (itemIds.length) {
            steps = await sequelize2.query(
                `
                SELECT
                    s.id AS stepId,
                    s.instOrderItemId,
                    s.instStepId,
                    s.status,
                    i.stepName,
                    i.standardTime,
                    i.stepNumber AS stepOrder
                FROM IIT_Petra.instOrderSteps s
                JOIN IIT_Petra.instSteps i ON i.instStepId = s.instStepId
                WHERE s.instOrderItemId IN (:ids)
                ORDER BY s.instOrderItemId, stepOrder
                `,
                { replacements: { ids: itemIds }, type: QueryTypes.SELECT }
            );
        }

        // Fetch step updates
        let stepUpdates = [];
        if (steps.length) {
            const stepIds = steps.map(s => s.stepId);
            stepUpdates = await sequelize2.query(
                `
                SELECT instOrderStepId, status, problem_note as note, image_before, image_after, createdAt
                FROM IIT_Petra.instOrderStepUpdates
                WHERE instOrderStepId IN (:ids)
                ORDER BY instOrderStepId, createdAt
                `,
                { replacements: { ids: stepIds }, type: QueryTypes.SELECT }
            );
        }

        // Map steps
        const stepMap = {};
        steps.forEach(s => {
            if (!stepMap[s.instOrderItemId]) stepMap[s.instOrderItemId] = [];
            stepMap[s.instOrderItemId].push({
                ...s,
                stepName: fixArabic(s.stepName),
                photos: stepUpdates
                    .filter(u => u.instOrderStepId === s.stepId)
                    .map(u => ({
                        url: u.image_after || u.image_before || null,
                        note: u.note || '',
                        type: u.status.toLowerCase(),
                        date: u.createdAt
                    }))
            });
        });

        // Last checkpoint per order
        const teamIds = [...new Set(items.map(i => i.teamId))];
        const lastCheckpoints = await sequelize2.query(
            `
            SELECT t.order_id, t.checkpoint_type, t.latitude, t.longitude
            FROM IIT_Petra.instTeamCheckpoints t
            INNER JOIN (
                SELECT order_id, MAX(createdAt) maxDate
                FROM IIT_Petra.instTeamCheckpoints
                WHERE team_id IN (:teamIds)
                GROUP BY order_id
            ) x ON x.order_id = t.order_id AND x.maxDate = t.createdAt
            `,
            { replacements: { teamIds }, type: QueryTypes.SELECT }
        );

        const checkpointMap = {};
        lastCheckpoints.forEach(c => {
            checkpointMap[c.order_id] = {
                type: c.checkpoint_type,
                lat: c.latitude,
                lng: c.longitude
            };
        });

        // Build orders response
        const orders = {};
        items.forEach(row => {
            if (!orders[row.instOrderId]) {
                orders[row.instOrderId] = {
                    orderNumber: row.order_number,
                    projectNo: row.projectNo,
                    projectName: row.projectName,
                    lastCheckpoint: checkpointMap[row.instOrderId] || null,
                    items: []
                };
            }

            orders[row.instOrderId].items.push({
                instOrderItemId: row.instOrderItemId,
                instReqDetId: row.instReqDetId,
                rowId: row.rowId,
                itemName: row.itemName,
                unitIdContract: row.unitIdContract,
                unitNo: row.unitNo,
                height: row.height,
                width: row.width,
                teamId: row.teamId,
                steps: stepMap[row.instOrderItemId] || []
            });
        });

        res.json({ success: true, data: { orders } });

    } catch (err) {
        console.error("❌ FETCH MY ORDERS ERROR:", err);
        res.status(500).json({ success: false, message: "Error fetching orders" });
    }
});

// GET /api/follow-up/my-projects
// Distinct projects the worker's team currently has assignments in, each
// with a representative orderId -- feeds the Home screen's project
// check-in picker. Project-level check-in reuses the existing per-order
// instTeamCheckpoints table/endpoint underneath (no schema change): the
// worker only ever sees/picks a project, and one of their real orders in
// it is carried along as the checkpoint's order_id.
router.get('/my-projects', authenticateToken, requirePermission(PERMISSIONS.FIELD_CHECKIN), async (req, res) => {
    try {
        const assignedEmpNo = req.user.assignedEmpNo;
        const rows = await sequelize.query(
            `
            SELECT DISTINCT p.projectNo, p.projectName, io.id AS orderId
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.masterControl ms ON ms.rowId = iod.rowId
            LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
            LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
            WHERE ira.assignedEmpNo = :assignedEmpNo AND p.projectNo IS NOT NULL
            ORDER BY p.projectNo
            `,
            { replacements: { assignedEmpNo }, type: sequelize.QueryTypes.SELECT }
        );
        const seen = new Map();
        rows.forEach((r) => {
            if (!seen.has(r.projectNo)) {
                seen.set(r.projectNo, { projectNo: r.projectNo, projectName: fixArabic(r.projectName), orderId: r.orderId });
            }
        });
        res.json({ success: true, data: Array.from(seen.values()) });
    } catch (err) {
        console.error("❌ MY PROJECTS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch your projects" });
    }
});

// GET /api/follow-up/team/checkin-status
// Resolves the worker's team's current project check-in state from the
// most recent inProject/outProject row in instTeamCheckpoints -- "in" iff
// that most recent event was an inProject with no later outProject.
router.get('/team/checkin-status', authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const team_id = await resolveTeamIdForUser(req.user);
        if (!team_id) {
            return res.json({ success: true, data: { checkedIn: false } });
        }
        // Ordered by id, not createdAt -- two checkpoints (e.g. a quick
        // check-in immediately followed by check-out) can land in the same
        // wall-clock second since this column has no fractional-second
        // precision, and ORDER BY createdAt DESC alone breaks that tie
        // arbitrarily (confirmed live: it picked the OLDER row). id is the
        // auto-increment PK, so it's always correctly monotonic.
        const rows = await sequelize2.query(
            `
            SELECT checkpoint_type, order_id, createdAt
            FROM IIT_Petra.instTeamCheckpoints
            WHERE team_id = :team_id AND checkpoint_type IN ('inProject', 'outProject')
            ORDER BY id DESC
            LIMIT 1
            `,
            { replacements: { team_id }, type: QueryTypes.SELECT }
        );
        const last = rows[0];
        if (!last || last.checkpoint_type !== 'inProject') {
            return res.json({ success: true, data: { checkedIn: false } });
        }
        let project = null;
        if (last.order_id) {
            const projRows = await sequelize.query(
                `
                SELECT p.projectNo, p.projectName
                FROM IIT_Petra.instOrders io
                LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
                LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
                WHERE io.id = :orderId
                LIMIT 1
                `,
                { replacements: { orderId: last.order_id }, type: QueryTypes.SELECT }
            );
            if (projRows[0]) {
                project = { projectNo: projRows[0].projectNo, projectName: fixArabic(projRows[0].projectName) };
            }
        }
        res.json({
            success: true,
            data: { checkedIn: true, orderId: last.order_id, project, since: last.createdAt },
        });
    } catch (err) {
        console.error("❌ CHECKIN STATUS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch check-in status" });
    }
});

// GET /api/follow-up/my-order-components
// Component-based counterpart to /my-orders above -- same
// ira.assignedEmpNo scoping, same orders/items grouping shape, but each
// item carries component completion stats (from Stock, via
// getUnitCompletionStats) instead of a fixed instOrderSteps checklist.
router.get('/my-order-components', authenticateToken, requirePermission(PERMISSIONS.FIELD_MY_ORDER_COMPONENTS), async (req, res) => {
    try {
        const assignedEmpNo = req.user.assignedEmpNo;

        const itemsRaw = await sequelize.query(
            `
    SELECT
       io.id AS instOrderId,
       io.order_number,
       p.projectNo,
       p.projectName,
       iod.id AS instOrderItemId,
       iod.instReqDetId,
       iod.rowId,
       iod.itemName,
       ms.unitIdContract,
       COALESCE(ms.unitIdDetail, iod.unitNo) As unitNo,
       iod.height,
       iod.width,
       ira.teamId
   FROM IIT_Petra.instOrderItems iod
   LEFT JOIN IIT_Petra.masterControl ms ON ms.rowId = iod.rowId
   LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
   LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
   LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
   LEFT JOIN IIT_Petra.instReqAssignments ira
       ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
    WHERE ira.assignedEmpNo = :assignedEmpNo
    ORDER BY io.id DESC, iod.id ASC
    `,
            { replacements: { assignedEmpNo }, type: sequelize.QueryTypes.SELECT }
        );

        if (!itemsRaw.length) {
            return res.json({ success: true, data: { orders: {} } });
        }

        const items = itemsRaw.map(r => ({
            ...r,
            itemName: fixArabic(r.itemName),
            projectName: fixArabic(r.projectName),
        }));

        const statsByItem = new Map(
            await Promise.all(
                items.map(async (row) => [row.instOrderItemId, await getUnitCompletionStats(row.instOrderItemId)])
            )
        );

        const orders = {};
        items.forEach(row => {
            if (!orders[row.instOrderId]) {
                orders[row.instOrderId] = {
                    orderNumber: row.order_number,
                    projectNo: row.projectNo,
                    projectName: row.projectName,
                    items: [],
                };
            }
            orders[row.instOrderId].items.push({
                instOrderItemId: row.instOrderItemId,
                instReqDetId: row.instReqDetId,
                rowId: row.rowId,
                itemName: row.itemName,
                unitIdContract: row.unitIdContract,
                unitNo: row.unitNo,
                height: row.height,
                width: row.width,
                teamId: row.teamId,
                stats: statsByItem.get(row.instOrderItemId),
            });
        });

        res.json({ success: true, data: { orders } });
    } catch (err) {
        console.error("❌ FETCH MY ORDER COMPONENTS ERROR:", err);
        res.status(500).json({ success: false, message: "Error fetching order components" });
    }
});

// ------------------------ HELPERS ------------------------
async function resolveTeamId(stepId) {
    const rows = await sequelize2.query(
        `
        SELECT ira.teamId
        FROM IIT_Petra.instOrderSteps s
        JOIN IIT_Petra.instOrderItems i ON i.id = s.instOrderItemId
        JOIN IIT_Petra.instReqAssignments ira
          ON ira.instReqDetId = i.instReqDetId
         AND ira.instOrderId = i.instOrderId
        WHERE s.id = :stepId
        LIMIT 1
        `,
        { replacements: { stepId }, type: QueryTypes.SELECT }
    );

    return rows[0]?.teamId || null;
}

// Resolves a logged-in user's real team_id. `req.user.teamId` from the JWT
// is always absent by design (InsUser.teamId is stale/unreliable — see the
// comment in auth.js login), so the real team is looked up via
// instTeams.leader_emp_no = assignedEmpNo, same as every write path that
// needs a team_id (checkpoints, step updates, etc.).
//
// Deliberately leader-only, not "any member of instTeamMembers" — per
// explicit direction (2026-09-09) this stays restricted to the team
// leader for now; broader per-employee site-access/tracking is a future
// task, not this fix. A regular (non-leader) team member's calls into
// this always resolve null, and the routes that depend on it correctly
// reject them -- see POST /location's NO_TEAM_ASSIGNED code, which exists
// specifically so the mobile client can stop retrying that permanent
// condition instead of hammering this endpoint.
async function resolveTeamIdForUser(reqUser) {
    if (reqUser.teamId) return reqUser.teamId;
    if (!reqUser.assignedEmpNo) return null;
    const rows = await sequelize.query(
        `SELECT id FROM IIT_Petra.instTeams WHERE leader_emp_no = :assignedEmpNo LIMIT 1`,
        { replacements: { assignedEmpNo: reqUser.assignedEmpNo }, type: QueryTypes.SELECT }
    );
    return rows[0]?.id || null;
}

// Workers hit /order-step/* with a client-supplied stepId and nothing
// previously checked that the step actually belongs to their own team —
// any authenticated worker could update/complete/report-issue on any
// other team's steps by guessing/incrementing stepId, including
// triggering the request-completion cascade below on unrelated projects.
// Managers/admins are allowed through since they legitimately act on
// behalf of any team from the web dashboard.
async function assertOwnsStep(reqUser, stepId) {
    if (reqUser.role === 'installation_manager' || reqUser.role === 'admin') return true;
    const [stepTeamId, userTeamId] = await Promise.all([
        resolveTeamId(stepId),
        resolveTeamIdForUser(reqUser),
    ]);
    return !!userTeamId && userTeamId === stepTeamId;
}

// Same guard as assertOwnsStep, one level up: the component-confirm route
// takes a client-supplied instOrderItemId directly (no stepId in the
// path), so it needs its own team-ownership check rather than reusing
// resolveTeamId (which joins through instOrderSteps).
async function resolveTeamIdForItem(instOrderItemId) {
    const rows = await sequelize2.query(
        `
        SELECT ira.teamId
        FROM IIT_Petra.instOrderItems i
        JOIN IIT_Petra.instReqAssignments ira
          ON ira.instReqDetId = i.instReqDetId
         AND ira.instOrderId = i.instOrderId
        WHERE i.id = :instOrderItemId
        LIMIT 1
        `,
        { replacements: { instOrderItemId }, type: QueryTypes.SELECT }
    );
    return rows[0]?.teamId || null;
}

async function assertOwnsItem(reqUser, instOrderItemId) {
    if (reqUser.role === 'installation_manager' || reqUser.role === 'admin') return true;
    const [itemTeamId, userTeamId] = await Promise.all([
        resolveTeamIdForItem(instOrderItemId),
        resolveTeamIdForUser(reqUser),
    ]);
    return !!userTeamId && userTeamId === itemTeamId;
}

// Upserts a team's live location, silently skipping if teamId doesn't
// reference a real row in instTeams (e.g. stale teamId on an office/admin
// account) — inserting would otherwise violate the FK constraint.
async function upsertTeamLocation(teamId, lat, lng) {
    if (!teamId || typeof lat !== 'number' || typeof lng !== 'number') return;
    // Reject (0,0) "null island" and other clearly-invalid fixes server-side
    // — this has recurred multiple times from client-side bugs (hardcoded
    // zeros, GPS not yet acquired), so don't rely solely on the client
    // to filter it out.
    if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return;
    const teamExists = await sequelize2.query(
        `SELECT 1 FROM IIT_Petra.instTeams WHERE id = :team_id LIMIT 1`,
        { replacements: { team_id: teamId }, type: QueryTypes.SELECT }
    );
    if (!teamExists.length) return;
    // UTC_TIMESTAMP(), not CURRENT_TIMESTAMP/NOW() — this MySQL server's
    // SYSTEM timezone is UTC+3 (confirmed live), and mysql2 reads DATETIME
    // columns back as naive UTC with no conversion. A local-time
    // ping_time would appear ~3 hours ahead of true Date.now() on the
    // frontend, which computes isOnline/isIdle as (now - lastPing) — a
    // team that actually went quiet up to ~3 hours ago could still show a
    // negative/near-zero elapsed time and read as perpetually active.
    await sequelize2.query(
        `
        INSERT INTO IIT_Petra.instTeamLocations
        (team_id, latitude, longitude, ping_time)
        VALUES (:team_id, :lat, :lng, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
            latitude = VALUES(latitude),
            longitude = VALUES(longitude),
            ping_time = UTC_TIMESTAMP();
        `,
        { replacements: { team_id: teamId, lat, lng }, type: QueryTypes.INSERT }
    );
}


// ------------------------ POST Step Update (Completed / In Progress) ------------------------
// Optional photo/video attachment on completion — the file field name
// ("media") is generic on purpose, since it may be either an image or a
// video; multer/storage don't care about content type, and image_after is
// just a URL string column regardless of what kind of file it points to.
router.post("/order-step/update", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), upload.single("media"), async (req, res) => {
    try {
        const { stepId, status, lat, lng } = req.body;
        const userId = req.user.userId;

        if (!stepId || !status) {
            return res.status(400).json({ success: false, message: "stepId and status required" });
        }

        if (!(await assertOwnsStep(req.user, stepId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this step" });
        }

        const mediaUrl = req.file ? `/uploads/steps/photos/${req.file.filename}` : null;

        // Update step status
        await sequelize2.query(
            `UPDATE IIT_Petra.instOrderSteps SET status = :status, updatedAt = NOW() WHERE id = :stepId`,
            { replacements: { stepId, status }, type: QueryTypes.UPDATE }
        );

        // Insert update record
        await InstOrderStepUpdates.create({
            instOrderStepId: stepId,
            user_id: userId,
            status,
            note: null,
            problem_note: null,
            image_before: null,
            image_after: mediaUrl,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Resolve teamId dynamically
        const teamId = await resolveTeamId(stepId);

        // Save location (optional)
        await upsertTeamLocation(teamId, lat, lng);

        // Broadcast a plain "something changed" event so every connected
        // dashboard re-fetches orders and runs its own detectChanges() —
        // which builds the field-news entry for this step change itself
        // (correctly localized/translated, fixArabic'd project name, and
        // the same item-label resolution used everywhere else on the
        // frontend). This route used to ALSO push a fully-formed
        // 'field_news' SSE event built from a separate, raw backend-side
        // query — that duplicated what detectChanges() already produces,
        // but disagreed with it: no fixArabic() on the project name (showed
        // as mojibake), no status translation (raw "Completed" instead of
        // the localized label), and a different item-label fallback order
        // than the frontend's own (it.unitNo ?? it.unitIdContract ??
        // it.itemName), so the two versions never matched on dedup and
        // both stayed visible as separate entries for the same event.
        try {
            notifyOrderUpdate();
        } catch (e) { console.error('Error sending field news update:', e); }

        // A request only ever advanced from "New" -> "Scheduled" (all items
        // assigned) — nothing ever moved it to "Completed" once the actual
        // installation work finished, so a fully-worked request just sat at
        // "Scheduled" forever in the Bunding Project board. Check whether
        // every step on every item under this request is now Completed, and
        // if so advance it.
        try {
            const reqRows = await sequelize2.query(`
                SELECT m.instReqMasterId, m.reqStatusId
                FROM IIT_Petra.instOrderSteps s
                JOIN IIT_Petra.instOrderItems i ON i.id = s.instOrderItemId
                JOIN IIT_Petra.instOrders o ON o.id = i.instOrderId
                JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = o.instReqMasterId
                WHERE s.id = :stepId
                LIMIT 1
            `, { replacements: { stepId }, type: QueryTypes.SELECT });

            const reqMasterId = reqRows[0]?.instReqMasterId;
            const currentReqStatus = reqRows[0]?.reqStatusId;
            // Only auto-advance from "Scheduled" (4), and only auto-revert
            // from "Completed" (8) — leave "New" (nothing assigned yet) and
            // any other status alone.
            if (reqMasterId && (currentReqStatus === 4 || currentReqStatus === 8)) {
                const stepCounts = await sequelize2.query(`
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN LOWER(s.status) = 'completed' THEN 1 ELSE 0 END) AS completed
                    FROM IIT_Petra.instOrderSteps s
                    JOIN IIT_Petra.instOrderItems i ON i.id = s.instOrderItemId
                    JOIN IIT_Petra.instOrders o ON o.id = i.instOrderId
                    WHERE o.instReqMasterId = :reqMasterId
                `, { replacements: { reqMasterId }, type: QueryTypes.SELECT });

                const { total, completed } = stepCounts[0] || {};
                const allCompleted = Number(total) > 0 && Number(completed) === Number(total);

                if (allCompleted && currentReqStatus === 4) {
                    await sequelize2.query(
                        `UPDATE IIT_Petra.instReqMaster SET reqStatusId = 8 WHERE instReqMasterId = :reqMasterId`,
                        { replacements: { reqMasterId } }
                    );
                } else if (!allCompleted && currentReqStatus === 8) {
                    // A step was reopened (e.g. an issue reported on already
                    // "Completed" work) — the request isn't actually done anymore.
                    await sequelize2.query(
                        `UPDATE IIT_Petra.instReqMaster SET reqStatusId = 4 WHERE instReqMasterId = :reqMasterId`,
                        { replacements: { reqMasterId } }
                    );
                }
            }
        } catch (e) { console.error('Error checking request completion:', e); }

        res.json({ success: true, media: mediaUrl });
    } catch (err) {
        console.error("❌ STEP UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update step" });
    }
});

// ------------------------ POST Step Photo ------------------------
router.post("/order-step/photo", authenticateToken, upload.single("photo"), async (req, res) => {
    try {
        const { stepId, lat, lng } = req.body;

        if (!stepId || !req.file) {
            return res.status(400).json({ success: false, message: "stepId and photo required" });
        }

        if (!(await assertOwnsStep(req.user, stepId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this step" });
        }

        const userId = req.user.userId;
        const photoUrl = `/uploads/steps/photos/${req.file.filename}`;

        // Save update row
        await InstOrderStepUpdates.create({
            instOrderStepId: stepId,
            user_id: userId,
            status: "in_progress",
            note: null,
            problem_note: null,
            image_before: null,
            image_after: photoUrl,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Resolve teamId dynamically
        const teamId = await resolveTeamId(stepId);

        // Save location
        await upsertTeamLocation(teamId, lat, lng);

        try { notifyOrderUpdate(); } catch (e) { /* ignore */ }
        res.json({ success: true, photo: { url: photoUrl, type: "after" } });
    } catch (err) {
        console.error("❌ STEP PHOTO UPLOAD ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to upload photo" });
    }
});

// ------------------------ POST Step Issue ------------------------
router.post("/order-step/issue", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), upload.single("photo"), async (req, res) => {
    try {
        const { stepId, note, lat, lng } = req.body;
        const userId = req.user.userId;

        if (!stepId || !note) {
            return res.status(400).json({ success: false, message: "stepId and note required" });
        }

        if (!(await assertOwnsStep(req.user, stepId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this step" });
        }

        let photoUrl = req.file ? `/uploads/steps/issues/${req.file.filename}` : null;

        // Create issue row
        await InstOrderStepUpdates.create({
            instOrderStepId: stepId,
            user_id: userId,
            status: "Issue",
            note: null,
            problem_note: note,
            image_before: photoUrl,
            image_after: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Update main step table
        await sequelize2.query(
            `UPDATE IIT_Petra.instOrderSteps SET status = 'Issue', updatedAt = NOW() WHERE id = :id`,
            { replacements: { id: stepId }, type: QueryTypes.UPDATE }
        );

        // Resolve teamId dynamically
        const teamId = await resolveTeamId(stepId);

        // Save location
        await upsertTeamLocation(teamId, lat, lng);

        try { notifyOrderUpdate(); } catch (e) { /* ignore */ }
        res.json({ success: true, photoUrl });
    } catch (err) {
        console.error("❌ STEP ISSUE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to report issue" });
    }
});


/** ------------------------
 * POST Team Checkpoint
 * ------------------------ */
router.post("/team/checkpoint", authenticateToken, requirePermission(PERMISSIONS.FIELD_CHECKIN), async (req, res) => {
    try {
        const { lat, lng, checkpointType, orderId, notes } = req.body;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            return res.status(400).json({ success: false, message: 'lat and lng (numbers) are required' });
        }
        // Reject (0,0) "null island" and other clearly-invalid fixes — same
        // guard as upsertTeamLocation, needed here too since this table is
        // written to directly, not through that helper.
        if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) {
            return res.status(400).json({ success: false, message: 'Invalid location coordinates' });
        }
        const user_id = req.user.userId;
        const team_id = await resolveTeamIdForUser(req.user);
        if (!team_id) {
            return res.status(400).json({
                success: false,
                message: `No team found for assignedEmpNo ${req.user.assignedEmpNo}`
            });
        }

        // Insert checkpoint
        // UTC_TIMESTAMP(), not NOW() — this MySQL server's SYSTEM timezone
        // is UTC+3 (confirmed live), and mysql2 reads DATETIME columns back
        // as naive UTC with no conversion applied. NOW() here would silently
        // bake in a 3-hour-ahead skew for every checkpoint, which the
        // frontend's field-news feed (built on real Date.now() UTC math)
        // would then read as "3 hours more recent than it really was" —
        // wrong "time ago" display and a ~51h instead of 48h expiry.
        await sequelize2.query(
            `
            INSERT INTO IIT_Petra.instTeamCheckpoints
            (team_id, user_id, order_id, checkpoint_type, latitude, longitude, notes, createdAt, updatedAt)
            VALUES (:team_id, :user_id, :order_id, :checkpoint_type, :latitude, :longitude, :notes, UTC_TIMESTAMP(), UTC_TIMESTAMP())
            `,
            {
                replacements: {
                    team_id,
                    user_id,
                    order_id: orderId || null,
                    checkpoint_type: checkpointType,
                    latitude: lat,
                    longitude: lng,
                    notes: notes || null
                },
                type: QueryTypes.INSERT
            }
        );

        // Update live location
        await upsertTeamLocation(team_id, lat, lng);

        try { notifyOrderUpdate(); } catch (e) { /* ignore */ }
        res.json({ success: true, message: "Checkpoint saved successfully" });
    } catch (err) {
        console.error("❌ TEAM CHECKPOINT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to save checkpoint" });
    }
});


/** ------------------------
 * GET Live Team Locations
 * ------------------------ */
router.get('/team/locations', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        // installation_supervisor only sees teams they supervise
        // (instTeams.supervisor_emp_no) -- same gap as GET /teams,
        // /instOrders/schedule, /instOrders/team-roster, and
        // /instOrders/assigned-components. Previously unscoped here too --
        // only looked correctly scoped by coincidence (few teams in the
        // test data actually have location pings).
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        // Return latest row per team with team info (optimized for MySQL/MariaDB)
        const rows = await sequelize2.query(
            `
      SELECT l.id, l.team_id, l.latitude, l.longitude, l.ping_time, t.name AS team_name, t.color
      FROM IIT_Petra.instTeamLocations l
      INNER JOIN IIT_Petra.instTeams t ON t.id = l.team_id
      INNER JOIN (
        SELECT team_id, MAX(ping_time) AS max_ping
        FROM IIT_Petra.instTeamLocations
        GROUP BY team_id
      ) latest ON latest.team_id = l.team_id AND latest.max_ping = l.ping_time
      ${isScoped ? 'WHERE t.supervisor_emp_no = :empNo' : ''}
      ORDER BY t.name
      `,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );

        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('❌ TEAM LOCATIONS ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch team locations' });
    }
});

/**
 * GET online status per team, for the manager dashboard's Active/Offline
 * indicator — a team is online if any of its logged-in members currently
 * has isOnline=true (set on login, cleared on explicit logout).
 */
router.get('/team/online-status', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        // installation_supervisor only sees teams they supervise -- same
        // gap/fix as GET /team/locations above.
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        // InsUser.teamId is stale/unreliable (the JWT deliberately omits it —
        // see auth.js login) — the real team is resolved the same way every
        // other endpoint does it: instTeams.leader_emp_no = assignedEmpNo.
        const rows = await sequelize2.query(
            `
            SELECT t.id AS team_id, MAX(u.isOnline) AS isOnline, MAX(u.lastSeenAt) AS lastSeenAt
            FROM IIT_Petra.InsUser u
            JOIN IIT_Petra.instTeams t ON t.leader_emp_no = u.assignedEmpNo
            ${isScoped ? 'WHERE t.supervisor_emp_no = :empNo' : ''}
            GROUP BY t.id
            `,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );
        res.json({
            success: true,
            data: rows.map(r => ({
                team_id: r.team_id,
                isOnline: !!r.isOnline,
                lastSeenAt: r.lastSeenAt,
            })),
        });
    } catch (err) {
        console.error('❌ TEAM ONLINE STATUS ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch online status' });
    }
});

/**
 * GET history for a team
 * Returns last N pings for team_id ordered by ping_time asc (for proper path drawing)
 */
router.get('/team/history/:teamId', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        const teamId = parseInt(req.params.teamId, 10);
        if (!teamId) return res.status(400).json({ success: false, message: 'teamId required' });

        // limit param optional
        const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

        const history = await sequelize2.query(
            `
      SELECT id, team_id, latitude, longitude, ping_time
      FROM IIT_Petra.instTeamLocations
      WHERE team_id = :teamId
      ORDER BY ping_time ASC
      LIMIT :limit
      `,
            { replacements: { teamId, limit }, type: QueryTypes.SELECT }
        );

        res.json({ success: true, data: history });
    } catch (err) {
        console.error('❌ TEAM HISTORY ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch team history' });
    }
});

// ------------------------ GET Last Checkpoint for Order ------------------------
router.get("/my-orders/:orderId/last-checkpoint", authenticateToken, async (req, res) => {
    try {
        const { orderId } = req.params;

        if (req.user.role !== 'installation_manager' && req.user.role !== 'admin') {
            const [order] = await sequelize2.query(
                `SELECT team_id FROM IIT_Petra.instOrders WHERE id = :orderId LIMIT 1`,
                { replacements: { orderId }, type: QueryTypes.SELECT }
            );
            const userTeamId = await resolveTeamIdForUser(req.user);
            if (!userTeamId || !order || order.team_id !== userTeamId) {
                return res.status(403).json({ success: false, message: "Not authorized for this order" });
            }
        }

        const rows = await sequelize2.query(
            `
            SELECT *
            FROM IIT_Petra.instTeamCheckpoints
            WHERE order_id = :orderId
            ORDER BY createdAt DESC
            LIMIT 1
            `,
            { replacements: { orderId }, type: QueryTypes.SELECT }
        );

        if (!rows.length) {
            return res.json({ success: true, data: null });
        }

        res.json({ success: true, data: rows[0] });
    } catch (err) {
        console.error("❌ LAST CHECKPOINT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch checkpoint" });
    }
});

// ===============================
// GET BY BARCODE (MinStock)
// ===============================
// ===============================
// STEP 1: GET STOCK + STOCKO
// ===============================
router.get("/scan-basic/:barcode", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const { barcode } = req.params;

        if (!barcode) {
            return res.status(400).json({
                success: false,
                status: "NOT_FOUND",
                message: "Barcode required"
            });
        }

        // out.barcode is a numeric column (orderNo+serialNo, same as
        // Stock.barcode in mainStock.js) — passing the raw string param
        // here relied on SQL Server's implicit varchar->int conversion,
        // which throws (caught below as a generic 500/"ERROR") instead of
        // a clean NOT_FOUND for anything scanned that isn't a pure digit
        // string (e.g. a QR/DataMatrix code, which this screen's scanner
        // also accepts). mainStock.js and glass.js both parseInt() before
        // querying for the same reason — match that here.
        const cleanBarcode = parseInt(barcode, 10);
        if (!Number.isInteger(cleanBarcode)) {
            return res.json({
                success: true,
                status: "NOT_FOUND",
                stock: null,
                hireNote: "Item not found in warehouse",
                canConfirm: false
            });
        }

        const empNo = req.user.assignedEmpNo;

        const stockResult = await withSqlRetry("minstock", (pool) => pool.request()
            .input("barcode", cleanBarcode)
            .query(`
                SELECT TOP 1 *
                FROM out
                WHERE barcode = @barcode
            `));

        if (!stockResult.recordset.length) {
            return res.json({
                success: true,
                status: "NOT_FOUND",
                stock: null,
                hireNote: "Item not found in warehouse",
                canConfirm: false
            });
        }

        const stock = stockResult.recordset[0];

        // =========================
        // GET EMPLOYEE PROJECTS
        // =========================
        const employeeProjects = await sequelize.query(
            `
            SELECT DISTINCT
                SUBSTRING_INDEX(j.projectNo, '-', 1) AS projectNo
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.instOrders io
                ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId
                AND ira.instOrderId = io.id
            LEFT JOIN IIT_Petra.masterControl m
                ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.project j
                ON m.projectId = j.projectId
            WHERE ira.assignedEmpNo = :assignedEmpNo
            `,
            {
                replacements: { assignedEmpNo: empNo },
                type: QueryTypes.SELECT,
            }
        );

        const normalize = (v) =>
            String(v || "")
                .split("-")[0]
                .trim()
                .toUpperCase();

        const allowed = new Set(
            employeeProjects.map(p => normalize(p.projectNo))
        );

        const itemProject = normalize(stock.projNo);

        const projectMatch = allowed.has(itemProject);

        const hireNote = projectMatch
            ? null
            : `⚠ Item belongs to project ${itemProject} (not assigned to you)`;

        return res.json({
            success: true,

            status: projectMatch ? "OK" : "PROJECT_MISMATCH",

            stock: {
                barcode,
                projNo: stock.projNo,
                projectName: stock.projectName || null,
                ProdctionNO: stock.ProdctionNO,
                UNO: stock.UNO,
                Prodc: stock.Prodc,
                OUTQTY: stock.OUTQTY,
                FNO: stock.FNO,
                BNO: stock.BNO,
            },

            hireNote,
            canConfirm: projectMatch
        });

    } catch (err) {
        console.error("SCAN ERROR:", err);
        res.status(500).json({
            success: false,
            status: "ERROR",
            message: "Failed to fetch data"
        });
    }
});

// GET /api/follow-up/scan-task/:barcode
// Dedicated resolver for the scan-first task screen: unlike scan-basic
// (which only confirms the scanned unit's *project* is one of the
// employee's assigned projects), this resolves the barcode all the way
// down to a specific instOrderItem the employee is actually assigned —
// the same instReqAssignments.assignedEmpNo join /my-orders uses — and
// returns that item's next pending step, so the scan screen has a real
// stepId to act against instead of the client having to cross-reference
// a separately-loaded /my-orders list by unit number itself.
router.get("/scan-task/:barcode", authenticateToken, requirePermission(PERMISSIONS.FIELD_SCAN_TASK), async (req, res) => {
    try {
        const { barcode } = req.params;
        const assignedEmpNo = req.user.assignedEmpNo;

        const cleanBarcode = parseInt(barcode, 10);
        if (!Number.isInteger(cleanBarcode)) {
            return res.json({ success: true, status: "NOT_FOUND", message: "Item not found in warehouse" });
        }

        const stockResult = await withSqlRetry("minstock", (pool) => pool.request()
            .input("barcode", cleanBarcode)
            .query(`SELECT TOP 1 * FROM out WHERE barcode = @barcode`));

        if (!stockResult.recordset.length) {
            return res.json({ success: true, status: "NOT_FOUND", message: "Item not found in warehouse" });
        }
        const stock = stockResult.recordset[0];

        // A unit's materials must be confirmed physically delivered to site
        // (see Check Delivery / InsDelivered) before any scan-task action --
        // assigning to yourself, or acting on an already-yours item -- makes
        // sense. Applies to every outcome below (OK and NOT_ASSIGNED alike),
        // not just self-assign, since scanning a not-yet-delivered barcode
        // is premature either way.
        const deliveryRows = await sequelize2.query(
            `SELECT InsStatus FROM IIT_Petra.InsDelivered WHERE Insbarcode = :barcode ORDER BY InsDeliverdDate DESC LIMIT 1`,
            { replacements: { barcode: cleanBarcode }, type: QueryTypes.SELECT }
        );
        if (deliveryRows[0]?.InsStatus !== 'DELIVERED') {
            return res.json({
                success: true,
                status: "NOT_DELIVERED",
                message: "This item hasn't been confirmed delivered yet -- confirm delivery first",
            });
        }

        // Same assignment join as /my-orders, scoped to this one employee —
        // deliberately not filtered by unit number in SQL, since
        // masterControl.unitIdDetail and out.UNO aren't guaranteed to be
        // the same type/format; matched numerically in JS below the same
        // way the mobile client already does it (parseInt comparison).
        const assignedItems = await sequelize.query(
            `
            SELECT
               io.id AS instOrderId,
               io.order_number,
               p.projectNo,
               p.projectName,
               iod.id AS instOrderItemId,
               iod.itemName,
               COALESCE(ms.unitIdDetail, iod.unitNo) AS unitNo,
               iod.height,
               iod.width,
               iod.sourceBarcode
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.masterControl ms ON ms.rowId = iod.rowId
            LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
            LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
            WHERE ira.assignedEmpNo = :assignedEmpNo
            `,
            { replacements: { assignedEmpNo }, type: QueryTypes.SELECT }
        );

        // unitIdDetail commonly holds '0' as an unset/placeholder value on
        // masterControl rows that were never assigned a real unit number —
        // shared across many items/employees, so it must never itself be
        // treated as a valid match key (confirmed live: two different
        // employees' item sets both "matched" on unitNo '0' before this
        // guard was added).
        //
        // normalizeUnitNo, not a plain parseInt -- unit numbers are often
        // alphanumeric ("CW-7", stored as "CW07" in masterControl but
        // "CW-7"/"CW10" in Stock), and a bare parseInt returns NaN for all
        // of those, which silently made every alphanumeric-labeled unit
        // report NOT_ASSIGNED even when it genuinely was (confirmed live).
        const scannedUnitNo = normalizeUnitNo(stock.UNO);
        const matched = (scannedUnitNo && scannedUnitNo !== '0'
            ? assignedItems.find((row) => normalizeUnitNo(row.unitNo) === scannedUnitNo)
            : undefined)
            // Falls back to a sourceBarcode match for "Unassigned"-bucket
            // items (see selfAssignUnit.js/services/instOrderComponents.js's
            // UNASSIGNED_UNIT_NO) -- these are scoped to one specific
            // barcode, not a real unit label, so unitNo never matches
            // Stock.UNO even when the item genuinely is this worker's own.
            // Covers both a true no-UNO item AND the numbering-mismatch
            // stopgap (a real UNO that just can't be mapped to a
            // masterControl unit) -- both land in the same bucket.
            ?? assignedItems.find((row) => row.sourceBarcode && String(row.sourceBarcode) === String(cleanBarcode));

        if (!matched) {
            return res.json({
                success: true,
                status: "NOT_ASSIGNED",
                message: `Item ${stock.UNO ?? ''} is not part of a project or order assigned to you`,
            });
        }

        // First scan of THIS barcode defines ITS OWN start time -- per
        // material, not per unit. A unit with several materials (e.g. unit
        // "07 B" with 3 barcodes) previously shared one instOrderItems-level
        // start time, so scanning the 2nd or 3rd material for the first
        // time showed elapsed time already accumulated from the 1st
        // material's scan (confirmed live). registerMaterialScan creates a
        // 'Pending' InstOrderComponent row on first scan only -- its
        // createdAt is this barcode's own start time, read back via
        // getUnitCompletionStats' per-material startedAt/completedAt.
        await registerMaterialScan({
            instOrderItemId: matched.instOrderItemId,
            barcode: cleanBarcode,
            productName: stock.Prodc,
            productionNo: stock.ProdctionNO,
        });

        const steps = await sequelize2.query(
            `
            SELECT
                s.id AS stepId,
                s.instOrderItemId,
                s.instStepId,
                s.status,
                i.stepName,
                i.standardTime,
                i.stepNumber AS stepOrder
            FROM IIT_Petra.instOrderSteps s
            JOIN IIT_Petra.instSteps i ON i.instStepId = s.instStepId
            WHERE s.instOrderItemId = :instOrderItemId
            ORDER BY stepOrder
            `,
            { replacements: { instOrderItemId: matched.instOrderItemId }, type: QueryTypes.SELECT }
        );

        const stepsFixed = steps.map((s) => ({ ...s, stepName: fixArabic(s.stepName) }));
        const nextStep = stepsFixed.find((s) => (s.status || '').toLowerCase() !== 'completed') || null;

        // Completion stats for this unit (the real warehouse-allocation
        // model, see services/instOrderComponents.js) -- shown alongside
        // the step checklist so a worker sees the materials list and
        // completion percentage without leaving this screen.
        const stats = await getUnitCompletionStats(matched.instOrderItemId);

        return res.json({
            success: true,
            status: "OK",
            item: {
                instOrderId: matched.instOrderId,
                orderNumber: matched.order_number,
                projectNo: matched.projectNo,
                projectName: fixArabic(matched.projectName),
                instOrderItemId: matched.instOrderItemId,
                itemName: fixArabic(matched.itemName),
                unitNo: matched.unitNo,
                height: matched.height,
                width: matched.width,
            },
            steps: stepsFixed,
            nextStep,
            allStepsCompleted: stepsFixed.length > 0 && !nextStep,
            stats,
        });
    } catch (err) {
        console.error("❌ SCAN TASK ERROR:", err);
        res.status(500).json({ success: false, status: "ERROR", message: "Failed to fetch task" });
    }
});

// POST /api/follow-up/order-component/confirm
// Field-worker counterpart to instOrders.js's manager-facing
// POST /instOrders/component/confirm — same underlying validation
// (recordComponentAction), but gated on FIELD_TRACKING instead of
// INSTALLATION_MANAGE_ORDERS, with its own team-ownership check so a
// worker can't confirm components against a unit outside their own team
// (mirrors assertOwnsStep's rationale for /order-step/*).
// Accepts an optional photo/video (multipart) alongside the plain-JSON
// body ManageOrders' web page and MyOrderComponentsScreen's manual-entry
// flow already send -- multer's single() no-ops on a non-multipart
// request (express.json() above it already parsed req.body by then), so
// this stays backward compatible with every existing caller.
router.post("/order-component/confirm", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), upload.single("media"), async (req, res) => {
    try {
        const { instOrderItemId, barcode, note } = req.body;
        if (!instOrderItemId || !barcode) {
            return res.status(400).json({ success: false, message: "instOrderItemId and barcode are required" });
        }

        if (!(await assertOwnsItem(req.user, instOrderItemId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this unit" });
        }

        const mediaUrl = req.file ? `/uploads/steps/photos/${req.file.filename}` : null;
        const mediaType = req.file?.mimetype?.startsWith("video") ? "video" : (req.file ? "image" : null);

        const result = await recordComponentAction({
            instOrderItemId,
            barcode,
            action: 'install',
            note,
            mediaUrl,
            mediaType,
            userId: req.user.userId,
            empNo: req.user.assignedEmpNo,
        });
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ CONFIRM COMPONENT (FIELD) ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to confirm component" });
    }
});

// POST /api/follow-up/order-component/report-issue
// Field-worker issue report on one scanned material -- requires both a
// note and a photo/video (mirrors /order-step/issue's media requirement,
// applied here at the component level instead of the step level). An
// already-Installed material can be re-flagged here; recordComponentAction
// updates its status in place rather than rejecting the second scan.
router.post("/order-component/report-issue", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), upload.single("media"), async (req, res) => {
    try {
        const { instOrderItemId, barcode, note } = req.body;
        if (!instOrderItemId || !barcode || !note?.trim()) {
            return res.status(400).json({ success: false, message: "instOrderItemId, barcode, and note are required" });
        }

        if (!(await assertOwnsItem(req.user, instOrderItemId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this unit" });
        }

        const mediaUrl = req.file ? `/uploads/steps/issues/${req.file.filename}` : null;
        const mediaType = req.file?.mimetype?.startsWith("video") ? "video" : (req.file ? "image" : null);

        const result = await recordComponentAction({
            instOrderItemId,
            barcode,
            action: 'issue',
            note,
            mediaUrl,
            mediaType,
            userId: req.user.userId,
            empNo: req.user.assignedEmpNo,
        });
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ REPORT COMPONENT ISSUE (FIELD) ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to report issue" });
    }
});

// POST /api/follow-up/order-component/mark-complete
// Field-worker counterpart to instOrders.js's manager-facing
// POST /instOrders/component/mark-complete — same team-ownership gate as
// the confirm/report-issue routes above.
router.post("/order-component/mark-complete", authenticateToken, requirePermission(PERMISSIONS.FIELD_TRACKING), async (req, res) => {
    try {
        const { instOrderItemId } = req.body;
        if (!instOrderItemId) {
            return res.status(400).json({ success: false, message: "instOrderItemId is required" });
        }

        if (!(await assertOwnsItem(req.user, instOrderItemId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this unit" });
        }

        const result = await markUnitComplete(instOrderItemId);
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ MARK UNIT COMPLETE (FIELD) ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to mark unit complete" });
    }
});

// POST /api/follow-up/order-component/pause
// Pauses the timer on one scanned-but-unconfirmed material with a required
// reason -- the paused interval is excluded from its duration once resumed
// (see pauseMaterialScan/resumeMaterialScan in services/instOrderComponents.js).
router.post("/order-component/pause", authenticateToken, requirePermission(PERMISSIONS.FIELD_SCAN_TASK), async (req, res) => {
    try {
        const { instOrderItemId, barcode, reason } = req.body;
        if (!instOrderItemId || !barcode) {
            return res.status(400).json({ success: false, message: "instOrderItemId and barcode are required" });
        }

        if (!(await assertOwnsItem(req.user, instOrderItemId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this unit" });
        }

        const result = await pauseMaterialScan({ instOrderItemId, barcode, reason });
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ PAUSE COMPONENT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to pause item" });
    }
});

// POST /api/follow-up/order-component/resume
router.post("/order-component/resume", authenticateToken, requirePermission(PERMISSIONS.FIELD_SCAN_TASK), async (req, res) => {
    try {
        const { instOrderItemId, barcode } = req.body;
        if (!instOrderItemId || !barcode) {
            return res.status(400).json({ success: false, message: "instOrderItemId and barcode are required" });
        }

        if (!(await assertOwnsItem(req.user, instOrderItemId))) {
            return res.status(403).json({ success: false, message: "Not authorized for this unit" });
        }

        const result = await resumeMaterialScan({ instOrderItemId, barcode });
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ RESUME COMPONENT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to resume item" });
    }
});

// POST /api/follow-up/order-item/self-assign
// Body: { barcode }. Lets a team leader claim a scanned unit that scan-task
// just reported as NOT_ASSIGNED, provided their team already has at least
// one other assignment in that unit's project -- see
// services/selfAssignUnit.js for the full chain this creates/reassigns.
router.post("/order-item/self-assign", authenticateToken, requirePermission(PERMISSIONS.FIELD_SCAN_TASK), async (req, res) => {
    try {
        const { barcode } = req.body;
        if (!barcode) {
            return res.status(400).json({ success: false, message: "barcode is required" });
        }
        const result = await selfAssignUnit({ barcode, reqUser: req.user });
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error("❌ SELF ASSIGN UNIT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to self-assign unit" });
    }
});

// POST /api/follow-up/scan-task/confirm-delivery
// Lets a worker confirm delivery inline from the Scan & Complete Task
// screen when GET /scan-task/:barcode reports NOT_DELIVERED -- reuses the
// same InsDelivered write/project-ownership check as
// POST /delivery-status (Check Delivery's own confirm action), but gated
// on FIELD_SCAN_TASK (this screen's own key) instead of
// FIELD_CHECK_DELIVERY, since this is a same-screen convenience action
// for a role that may not hold the separate Check Delivery permission.
router.post("/scan-task/confirm-delivery", authenticateToken, requirePermission(PERMISSIONS.FIELD_SCAN_TASK), async (req, res) => {
    try {
        const { barcode } = req.body;
        if (!barcode) {
            return res.status(400).json({ success: false, message: "Barcode required" });
        }
        await confirmDeliveryLogic(barcode, null, req.user.assignedEmpNo, 'DELIVERED', null);
        res.json({ success: true, message: "Delivery confirmed" });
    } catch (err) {
        console.error("❌ SCAN TASK CONFIRM DELIVERY ERROR:", err);
        res.status(err.statusCode || 500).json({
            success: false,
            message: err.message,
            hireNote: err.hireNote || null,
        });
    }
});

// GET /api/follow-up/delivered-items
router.get('/delivered-items', authenticateToken, requirePermission(PERMISSIONS.FIELD_CHECK_DELIVERY), async (req, res) => {
    try {
        const assignedEmpNo = req.user.assignedEmpNo;

        if (!assignedEmpNo) {
            return res.status(400).json({
                success: false,
                message: 'No assignedEmpNo on token'
            });
        }

        // ===============================
        // CHECKED-IN PROJECT (scope restricted to this one project, not
        // every project this employee is ever assigned to -- same
        // checked-in-project resolution as GET /team/checkin-status, so
        // Check Delivery only ever shows the site the team is actually
        // standing at right now, not their whole project history).
        // ===============================
        const team_id = await resolveTeamIdForUser(req.user);
        let checkedInOrderId = null;
        if (team_id) {
            const checkpointRows = await sequelize2.query(
                `
                SELECT checkpoint_type, order_id
                FROM IIT_Petra.instTeamCheckpoints
                WHERE team_id = :team_id AND checkpoint_type IN ('inProject', 'outProject')
                ORDER BY id DESC
                LIMIT 1
                `,
                { replacements: { team_id }, type: QueryTypes.SELECT }
            );
            const lastCheckpoint = checkpointRows[0];
            if (lastCheckpoint?.checkpoint_type === 'inProject') {
                checkedInOrderId = lastCheckpoint.order_id;
            }
        }
        if (!checkedInOrderId) {
            return res.json({ success: true, data: [], checkedIn: false });
        }
        const checkedInProjRows = await sequelize.query(
            `
            SELECT p.projectNo, p.projectName
            FROM IIT_Petra.instOrders io
            LEFT JOIN IIT_Petra.instReqMaster m ON io.instReqMasterId = m.instReqMasterId
            LEFT JOIN IIT_Petra.project p ON m.projectId = p.projectId
            WHERE io.id = :orderId
            LIMIT 1
            `,
            { replacements: { orderId: checkedInOrderId }, type: QueryTypes.SELECT }
        );
        if (!checkedInProjRows[0]?.projectNo) {
            return res.json({ success: true, data: [], checkedIn: false });
        }

        const projectMap = new Map();
        const checkedInProjectNo = normalizeProjectNo(checkedInProjRows[0].projectNo);
        projectMap.set(checkedInProjectNo, {
            projectNo: checkedInProjectNo,
            projectName: safeArabic(checkedInProjRows[0].projectName),
        });

        const projectNos = [...projectMap.keys()].slice(0, 200);

        const quoted = projectNos
            .map(p => `'${p.replace(/'/g, "''")}'`)
            .join(',');

        // ===============================
        // MINSTOCK DATA
        // ===============================
        const result = await withSqlRetry('minstock', (pool) => pool.request().query(`
            SELECT
                [A],
                [orderNo],
                [serialNo],
                [projNo],
                [ProdctionNO],
                [C],
                [Prodc],
                [UNO],
                [OUTQTY],
                [Note],
                [DATEO],
                [BNO],
                [FNO],
                [DRIVER],
                [FORML],
                [barcode]
            FROM [out]
            WHERE LEFT([projNo], CHARINDEX('-', [projNo] + '-') - 1)
                  IN (${quoted})
            ORDER BY [projNo] DESC
        `));

        // ===============================
        // DELIVERED
        // ===============================
        const deliveredRows = await sequelize2.query(
            `
            SELECT
                Insbarcode,
                InsDeliverdDate,
                InsEmp_no,
                InsDeliveredNote,
                InsStatus,
                InsPhotoUrl
            FROM IIT_Petra.InsDelivered
            WHERE Insbarcode IS NOT NULL
            ORDER BY InsDeliverdDate ASC
            `,
            { type: QueryTypes.SELECT }
        );

        const deliveredMap = new Map();

        // ORDER BY ... ASC above means the last write here (per barcode) is
        // the most recent status update, so later rows correctly override earlier ones.
        deliveredRows.forEach((d) => {
            deliveredMap.set(
                String(d.Insbarcode || '').trim(),
                {
                    delivered: true,
                    deliveredDate: d.InsDeliverdDate,
                    deliveredBy: d.InsEmp_no,
                    deliveredNote: d.InsDeliveredNote,
                    status: d.InsStatus || 'DELIVERED',
                    photoUrl: d.InsPhotoUrl || null,
                }
            );
        });

        // ===============================
        // MERGE
        // ===============================
        const merged = result.recordset.map((row) => {

            const projNo = normalizeProjectNo(row.projNo);

            const project = projectMap.get(projNo);

            const barcode = String(row.barcode || '').trim();

            const deliveredInfo = deliveredMap.get(barcode);

            return {
                ...row,

                projNo,

                projName:
                    fixArabic(project?.projectName || row.projectName || "") || null,

                projectName: project?.projectName || null,

                delivered: !!deliveredInfo,

                deliveredStatus: deliveredInfo ? deliveredInfo.status : 'PENDING',

                deliveredDate: deliveredInfo?.deliveredDate || null,

                deliveredBy: deliveredInfo?.deliveredBy || null,

                deliveredNote: deliveredInfo?.deliveredNote || null,

                photoUrl: deliveredInfo?.photoUrl || null,
            };
        });

        res.json({
            success: true,
            data: merged,
            checkedIn: true,
            project: { projectNo: checkedInProjectNo, projectName: fixArabic(checkedInProjRows[0].projectName) },
        });

    } catch (err) {
        console.error('❌ DELIVERED ITEMS ERROR:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch delivered items'
        });
    }
});

/* ===============================================================
   HELPER: shared delivery confirmation logic
================================================================ */
async function confirmDeliveryLogic(barcode, note, empNo, status = 'DELIVERED', photoUrl = null) {
    // out.barcode is numeric (see the parseInt in /scan-basic above and in
    // mainStock.js/glass.js) — comparing it against a varchar param relies
    // on an implicit SQL-side conversion that throws for non-numeric input
    // instead of a clean "not found".
    const cleanBarcode = parseInt(String(barcode).trim(), 10);
    if (!Number.isInteger(cleanBarcode)) {
        const err = new Error("Barcode not found");
        err.statusCode = 404;
        throw err;
    }
    const stockResult = await withSqlRetry("minstock", (pool) => pool.request()
        .input('barcode', cleanBarcode)
        .query(`SELECT TOP 1 projNo FROM out WHERE barcode = @barcode`));

    const stockItem = stockResult.recordset[0];
    if (!stockItem) {
        const err = new Error("Barcode not found");
        err.statusCode = 404;
        throw err;
    }

    const itemProjectNo = normalizeProjectNo(stockItem.projNo);

    const employeeProjects = await sequelize.query(
        `SELECT DISTINCT SUBSTRING_INDEX(j.projectNo, '-', 1) AS projectNo
         FROM IIT_Petra.instOrderItems iod
         LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
         LEFT JOIN IIT_Petra.instReqAssignments ira
             ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
         LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
         LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
         WHERE ira.assignedEmpNo = :assignedEmpNo`,
        { replacements: { assignedEmpNo: empNo }, type: QueryTypes.SELECT }
    );

    const allowedProjects = new Set(
        employeeProjects.map(p => normalizeProjectNo(p.projectNo))
    );

    if (!allowedProjects.has(itemProjectNo)) {
        const err = new Error(`Item belongs to project ${itemProjectNo} — not assigned to you`);
        err.statusCode = 403;
        err.hireNote = "NOT ASSIGNED PROJECT";
        throw err;
    }

    await sequelize2.query(
        `INSERT INTO IIT_Petra.InsDelivered (Insbarcode, InsEmp_no, InsDeliverdDate, InsDeliveredNote, InsStatus, InsPhotoUrl)
         VALUES (:barcode, :empNo, NOW(), :note, :status, :photoUrl)`,
        { replacements: { barcode: cleanBarcode, empNo, note: note || null, status, photoUrl } }
    );
}

// POST /api/follow-up/confirm-delivery
router.post("/confirm-delivery", authenticateToken, async (req, res) => {
    try {
        const { barcode, note } = req.body;
        const empNo = req.user.assignedEmpNo;
        if (!barcode) return res.status(400).json({ success: false, message: "Barcode required" });
        await confirmDeliveryLogic(barcode, note, empNo);
        res.json({ success: true, message: "Delivery confirmed" });
    } catch (err) {
        console.error("CONFIRM ERROR:", err);
        res.status(err.statusCode || 500).json({
            success: false,
            message: err.message,
            hireNote: err.hireNote || null,
        });
    }
});

// POST /api/follow-up/confirm-delivery-batch
router.post("/confirm-delivery-batch", authenticateToken, async (req, res) => {
    const { items } = req.body;
    const empNo = req.user.assignedEmpNo;
    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "items array required" });
    }
    const results = [];
    for (const item of items) {
        try {
            await confirmDeliveryLogic(item.barcode, item.note, empNo);
            results.push({ id: item.id, success: true });
        } catch (err) {
            results.push({ id: item.id, success: false, error: err.message });
        }
    }
    res.json({ success: true, results });
});

// POST /api/follow-up/delivery-status
// Confirms a delivery as DELIVERED or MISSING, with an optional photo (mobile).
router.post("/delivery-status", authenticateToken, requirePermission(PERMISSIONS.FIELD_CHECK_DELIVERY), uploadDeliveryPhoto.single("photo"), async (req, res) => {
    try {
        const { barcode, note } = req.body;
        const status = (req.body.status || "DELIVERED").toUpperCase();
        const empNo = req.user.assignedEmpNo;

        if (!barcode) return res.status(400).json({ success: false, message: "Barcode required" });
        if (!["DELIVERED", "MISSING"].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be DELIVERED or MISSING" });
        }
        if (status === "MISSING" && !note) {
            return res.status(400).json({ success: false, message: "Note required when reporting an item missing" });
        }

        const photoUrl = req.file ? `/uploads/deliveries/${req.file.filename}` : null;

        await confirmDeliveryLogic(barcode, note, empNo, status, photoUrl);

        res.json({ success: true, status, photoUrl });
    } catch (err) {
        console.error("DELIVERY STATUS ERROR:", err);
        res.status(err.statusCode || 500).json({
            success: false,
            message: err.message,
            hireNote: err.hireNote || null,
        });
    }
});

// POST /api/follow-up/location
// Periodic location ping from the mobile app; upserts the employee's team
// location so it shows up wherever instTeamLocations is already consumed (SSE dashboard).
router.post("/location", authenticateToken, async (req, res) => {
    try {
        const { lat, lng } = req.body;
        if (typeof lat !== "number" || typeof lng !== "number") {
            return res.status(400).json({ success: false, message: "lat and lng (numbers) are required" });
        }

        const teamId = await resolveTeamIdForUser(req.user);
        if (!teamId) {
            // Distinct `code` (not just the message) so the mobile client can
            // reliably tell "this account will never resolve a team" (a
            // regular, non-leader team member -- resolveTeamIdForUser only
            // matches instTeams.leader_emp_no, a deliberate restriction, see
            // that function's own comment) apart from a transient failure
            // worth a normal retry. Without this, mobile/tasks/locationTask.ts
            // has no way to distinguish the two and keeps retrying a call
            // that can never succeed for that account -- confirmed live
            // (2026-09-09) as a tight ~3s repeat loop for a non-leader
            // employee, likely an expo-location/Android quirk not honoring
            // the configured 30-minute interval.
            return res.status(400).json({ success: false, code: "NO_TEAM_ASSIGNED", message: "No team assigned to this user" });
        }

        // upsertTeamLocation silently no-ops if teamId doesn't reference a
        // real instTeams row (e.g. a stale teamId on an office/admin account),
        // avoiding an FK-constraint error for accounts not on a real field team.
        await upsertTeamLocation(teamId, lat, lng);
        res.json({ success: true });
    } catch (err) {
        console.error("LOCATION PING ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record location" });
    }
});

/** ------------------------
 * GET Check-in/out + production report
 * Pairs each inProject checkpoint with the next outProject checkpoint for
 * the same team+order, and counts installation steps completed by that
 * team's members while on-site during that visit.
 * ------------------------ */
router.get('/reports/checkin-checkout', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        // Team names read correctly via sequelize2, but the `project` table's
        // Arabic text needs the primary `sequelize` connection's latin1->UTF-8
        // workaround (same pattern as instOrders.js's /assigned endpoint,
        // which joins the same table) — this legacy DB has inconsistent
        // per-table encoding, so the two are queried separately and merged.
        const teamRows = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams`,
            { type: QueryTypes.SELECT }
        );
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const { from, to } = req.query;
        const dateFilter = [];
        const replacements = {};
        if (from) { dateFilter.push('cp.createdAt >= :from'); replacements.from = `${from} 00:00:00`; }
        if (to) { dateFilter.push('cp.createdAt <= :to'); replacements.to = `${to} 23:59:59`; }
        const dateWhere = dateFilter.length ? ` AND ${dateFilter.join(' AND ')}` : '';

        const checkpoints = await sequelize.query(
            `
            SELECT
                cp.team_id,
                cp.order_id,
                cp.checkpoint_type,
                cp.createdAt,
                io.order_number AS orderNumber,
                proj.projectName,
                proj.projectNo
            FROM IIT_Petra.instTeamCheckpoints cp
            LEFT JOIN IIT_Petra.instOrders io ON io.id = cp.order_id
            LEFT JOIN (
                SELECT iod.instOrderId, MIN(j.projectName) AS projectName, MIN(j.projectNo) AS projectNo
                FROM IIT_Petra.instOrderItems iod
                LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
                LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
                GROUP BY iod.instOrderId
            ) proj ON proj.instOrderId = io.id
            WHERE cp.checkpoint_type IN ('inProject', 'outProject')
              AND cp.order_id IS NOT NULL${dateWhere}
            ORDER BY cp.team_id, cp.order_id, cp.createdAt ASC
            `,
            { type: QueryTypes.SELECT, replacements }
        );

        // Materials confirmed installed per order, in the same window — the
        // component-tracking equivalent of the old completed-steps query.
        // InstOrderComponents lives on the utf8mb4 connection but joins fine
        // against instOrderItems/instOrders (same physical schema, see
        // config/db.js) since nothing selected here needs Arabic decoding.
        const orderIds = [...new Set(checkpoints.map(c => c.order_id))];
        const installedComponents = orderIds.length
            ? await sequelizeUtf8.query(
                `
                SELECT iod.instOrderId AS orderId, c.updatedAt AS completedAt
                FROM IIT_Petra.InstOrderComponents c
                JOIN IIT_Petra.instOrderItems iod ON iod.id = c.instOrderItemId
                WHERE iod.instOrderId IN (:orderIds) AND c.status = 'Installed'
                `,
                { replacements: { orderIds }, type: QueryTypes.SELECT }
            )
            : [];

        // Pair sequential inProject -> outProject per team+order
        const visits = [];
        const byKey = new Map();
        for (const cp of checkpoints) {
            const key = `${cp.team_id}|${cp.order_id}`;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(cp);
        }

        const MAX_VISIT_MINUTES = 16 * 60; // abandoned check-ins (forgot to check out,
        // app crash, etc.) shouldn't pair with a much-later checkout and produce a
        // multi-day "visit" — treat those as abandoned and skip them instead.
        for (const [, events] of byKey) {
            let pendingIn = null;
            for (const ev of events) {
                if (ev.checkpoint_type === 'inProject') {
                    pendingIn = ev;
                } else if (ev.checkpoint_type === 'outProject' && pendingIn) {
                    const checkIn = new Date(pendingIn.createdAt);
                    const checkOut = new Date(ev.createdAt);
                    if ((checkOut - checkIn) / 60000 > MAX_VISIT_MINUTES) {
                        pendingIn = null;
                        continue;
                    }
                    const itemsInWindow = installedComponents.filter(
                        c => c.orderId === ev.order_id &&
                            new Date(c.completedAt) >= checkIn &&
                            new Date(c.completedAt) <= checkOut
                    );
                    const itemsCompleted = itemsInWindow.length;
                    const durationMinutes = Math.round((checkOut - checkIn) / 60000);
                    // Materials confirmed per hour on-site — a plain
                    // productivity rate, not a comparison to a standard (no
                    // per-material standard time exists in the component
                    // model, unlike the old per-step one). Null when nothing
                    // was completed, since the rate is meaningless.
                    const itemsPerHour = itemsCompleted > 0 && durationMinutes > 0
                        ? Math.round((itemsCompleted / (durationMinutes / 60)) * 10) / 10
                        : null;

                    visits.push({
                        teamId: ev.team_id,
                        teamName: teamNameById.get(ev.team_id) || `Team ${ev.team_id}`,
                        orderId: ev.order_id,
                        orderNumber: ev.orderNumber,
                        projectName: fixArabic(ev.projectName),
                        projectNo: ev.projectNo,
                        checkIn: pendingIn.createdAt,
                        checkOut: ev.createdAt,
                        durationMinutes,
                        itemsCompleted,
                        itemsPerHour,
                    });
                    pendingIn = null;
                }
            }
        }

        visits.sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));
        res.json({ success: true, data: visits });
    } catch (err) {
        console.error("CHECKIN/CHECKOUT REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build report" });
    }
});

// Meters between two lat/lng points -- standard haversine, accurate enough
// for a 500m threshold check (no need for a geodesy library here).
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const CHECKIN_LOCATION_THRESHOLD_METERS = 500;

/** ------------------------
 * GET Check-in location verification report
 * Flags 'inProject' checkpoints where the team's actual GPS location
 * doesn't match the project's saved location within 500m -- catches wrong
 * GPS, stale/missing project location data, or genuine attendance issues.
 * Reuses the same project-location resolution as instOrders.js's
 * GET /team-roster (direct @lat,lng in mapAddress, or ProjectMapCache for
 * short Google Maps links) rather than re-resolving live here -- this is a
 * read-only report, so a project whose short link hasn't been resolved yet
 * is surfaced as 'noLocationData' rather than triggering a live fetch.
 * ------------------------ */
router.get('/reports/checkin-location-check', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        const teamRows = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams`,
            { type: QueryTypes.SELECT }
        );
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const { from, to } = req.query;
        const dateFilter = [];
        const replacements = {};
        if (from) { dateFilter.push('cp.createdAt >= :from'); replacements.from = `${from} 00:00:00`; }
        if (to) { dateFilter.push('cp.createdAt <= :to'); replacements.to = `${to} 23:59:59`; }
        const dateWhere = dateFilter.length ? ` AND ${dateFilter.join(' AND ')}` : '';

        // Same project-join path as /reports/checkin-checkout above --
        // instOrderItems -> masterControl -> project, not instReqMaster
        // (that's the wrong path for this table's project link).
        const checkpoints = await sequelize.query(
            `
            SELECT
                cp.id AS checkpointId,
                cp.team_id,
                cp.order_id,
                cp.latitude,
                cp.longitude,
                cp.createdAt,
                io.order_number AS orderNumber,
                proj.projectId,
                proj.projectName,
                proj.projectNo,
                proj.mapAddress
            FROM IIT_Petra.instTeamCheckpoints cp
            LEFT JOIN IIT_Petra.instOrders io ON io.id = cp.order_id
            LEFT JOIN (
                SELECT iod.instOrderId, MIN(j.projectId) AS projectId, MIN(j.projectName) AS projectName,
                       MIN(j.projectNo) AS projectNo, MIN(j.mapAddress) AS mapAddress
                FROM IIT_Petra.instOrderItems iod
                LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
                LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
                GROUP BY iod.instOrderId
            ) proj ON proj.instOrderId = io.id
            WHERE cp.checkpoint_type = 'inProject'
              AND cp.order_id IS NOT NULL${dateWhere}
            ORDER BY cp.createdAt DESC
            `,
            { type: QueryTypes.SELECT, replacements }
        );

        // Resolve each distinct project's coordinates once -- same
        // resolution rules as GET /team-roster: a direct @lat,lng in
        // mapAddress is parsed inline; a short Google Maps link only
        // resolves from ProjectMapCache (no live fetch here).
        const projectIds = [...new Set(checkpoints.map(c => c.projectId).filter(Boolean))];
        const mapCache = projectIds.length
            ? await ProjectMapCache.findAll({ where: { projectId: projectIds } })
            : [];
        const mapCacheByProjectId = new Map(mapCache.map(c => [c.projectId, c]));

        const coordsByProjectId = new Map();
        for (const c of checkpoints) {
            if (!c.projectId || coordsByProjectId.has(c.projectId)) continue;
            let coordinates = extractCoords(c.mapAddress);
            if (!coordinates && isShortMapLink(c.mapAddress)) {
                const hit = mapCacheByProjectId.get(c.projectId);
                if (hit && hit.mapAddress === c.mapAddress) coordinates = hit.coordinates;
            }
            coordsByProjectId.set(c.projectId, coordinates);
        }

        const data = checkpoints.map((cp) => {
            const projectCoords = cp.projectId ? coordsByProjectId.get(cp.projectId) : null;
            let projectLat = null;
            let projectLng = null;
            if (projectCoords) {
                const [latStr, lngStr] = projectCoords.split(',').map((s) => s.trim());
                projectLat = parseFloat(latStr);
                projectLng = parseFloat(lngStr);
            }

            let status;
            let distanceMeters = null;
            if (!cp.projectId) {
                status = 'noProjectLinked';
            } else if (projectLat == null || Number.isNaN(projectLat) || projectLng == null || Number.isNaN(projectLng)) {
                status = 'noLocationData';
            } else {
                distanceMeters = Math.round(
                    haversineMeters(Number(cp.latitude), Number(cp.longitude), projectLat, projectLng)
                );
                status = distanceMeters > CHECKIN_LOCATION_THRESHOLD_METERS ? 'mismatch' : 'ok';
            }

            return {
                checkpointId: cp.checkpointId,
                teamId: cp.team_id,
                teamName: teamNameById.get(cp.team_id) || `Team ${cp.team_id}`,
                orderId: cp.order_id,
                orderNumber: cp.orderNumber,
                projectId: cp.projectId,
                projectName: fixArabic(cp.projectName),
                projectNo: cp.projectNo,
                checkedAt: cp.createdAt,
                checkpointLat: Number(cp.latitude),
                checkpointLng: Number(cp.longitude),
                projectLat,
                projectLng,
                distanceMeters,
                status,
            };
        });

        res.json({ success: true, data, thresholdMeters: CHECKIN_LOCATION_THRESHOLD_METERS });
    } catch (err) {
        console.error("CHECKIN LOCATION CHECK REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build report" });
    }
});

/** ------------------------
 * GET Issue/rework frequency report
 * Aggregates InstOrderComponents rows with status='Issue' by material
 * (which product types disproportionately cause problems) and by team
 * (which teams report issues disproportionately).
 *
 * Unlike the old instOrderStepUpdates-based version, there's no
 * active/history split here: InstOrderComponents is a current-state row
 * per (item, barcode), not an append-only log (see the model's own
 * comment) -- once a flagged material is reconfirmed Installed, its
 * Issue record is overwritten in place with no trace of the prior state,
 * so "issues later fixed by the worker" genuinely can't be reconstructed
 * from this schema. This only ever shows materials CURRENTLY flagged.
 * ------------------------ */
router.get('/reports/issues', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        const { from, to } = req.query;
        const dateFilter = [];
        const replacements = {};
        if (from) { dateFilter.push('c.updatedAt >= :from'); replacements.from = `${from} 00:00:00`; }
        if (to) { dateFilter.push('c.updatedAt <= :to'); replacements.to = `${to} 23:59:59`; }
        const dateWhere = dateFilter.length ? ` AND ${dateFilter.join(' AND ')}` : '';

        // InstOrderComponents (utf8mb4 connection) joined straight to
        // instOrderItems/instReqAssignments/instOrders/masterControl (same
        // physical schema, see config/db.js) -- none of the columns
        // selected here need Arabic decoding except productName/unitNo,
        // defensively passed through fixArabic() below same as elsewhere.
        const rows = await sequelizeUtf8.query(
            `
            SELECT
                c.id,
                c.note,
                c.updatedAt AS createdAt,
                c.productName,
                c.mediaUrl,
                ira.teamId,
                io.order_number AS orderNumber,
                m.unitIdDetail AS unitNo
            FROM IIT_Petra.InstOrderComponents c
            JOIN IIT_Petra.instOrderItems iod ON iod.id = c.instOrderItemId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = iod.instOrderId
            LEFT JOIN IIT_Petra.instOrders io ON io.id = iod.instOrderId
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            WHERE c.status = 'Issue'${dateWhere}
            ORDER BY c.updatedAt DESC
            `,
            { type: QueryTypes.SELECT, replacements }
        );

        const teamRows = await sequelize2.query(`SELECT id, name FROM IIT_Petra.instTeams`, { type: QueryTypes.SELECT });
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const byProduct = new Map();
        const byTeam = new Map();
        for (const r of rows) {
            const productName = fixArabic(r.productName) || 'Unknown material';
            byProduct.set(productName, (byProduct.get(productName) || 0) + 1);

            if (r.teamId) {
                const teamName = teamNameById.get(r.teamId) || `Team ${r.teamId}`;
                const key = `${r.teamId}|${teamName}`;
                byTeam.set(key, (byTeam.get(key) || 0) + 1);
            }
        }

        const byProductType = Array.from(byProduct.entries())
            .map(([productName, count]) => ({ productName, count }))
            .sort((a, b) => b.count - a.count);

        const byTeamArr = Array.from(byTeam.entries())
            .map(([key, count]) => {
                const [teamId, teamName] = key.split('|');
                return { teamId: Number(teamId), teamName, count };
            })
            .sort((a, b) => b.count - a.count);

        // Follow-up notes managers have attached to these issues — merged in
        // here so the frontend can render each issue with its note (if any)
        // in a single request. issueId now references InstOrderComponents.id
        // going forward (it's a plain, un-constrained BIGINT column — see
        // models/FollowUpNotes.js — so no migration needed, but notes
        // attached to pre-migration instOrderStepUpdates ids won't surface
        // here any more).
        const issueIds = rows.map(r => r.id);
        const notes = issueIds.length
            ? await FollowUpNotes.findAll({ where: { issueId: issueIds } })
            : [];
        const userIds = [...new Set(notes.flatMap(n => [n.createdBy, n.resolvedBy]).filter(Boolean))];
        const users = userIds.length
            ? await User.findAll({ where: { userId: userIds }, attributes: ['userId', 'firstName', 'lastName', 'username'] })
            : [];
        const userById = new Map(users.map(u => [u.userId, u]));
        const displayName = (u) =>
            !u ? null : ([fixArabic(u.firstName), fixArabic(u.lastName)].filter(Boolean).join(' ').trim() || u.username);
        const noteByIssueId = new Map(notes.map(n => [n.issueId, n]));

        const issues = rows.map(r => {
            const note = noteByIssueId.get(r.id);
            return {
                issueId: r.id,
                problemNote: fixArabic(r.note),
                createdAt: r.createdAt,
                productName: fixArabic(r.productName) || 'Unknown material',
                teamId: r.teamId,
                teamName: r.teamId ? teamNameById.get(r.teamId) || `Team ${r.teamId}` : null,
                orderNumber: r.orderNumber,
                unitNo: r.unitNo,
                photo: r.mediaUrl || null,
                followUpNote: note
                    ? {
                        id: note.id,
                        note: note.note,
                        resolved: !!note.resolved,
                        createdAt: note.createdAt,
                        createdBy: displayName(userById.get(note.createdBy)),
                        resolvedAt: note.resolvedAt,
                        resolvedBy: displayName(userById.get(note.resolvedBy)),
                    }
                    : null,
            };
        });

        res.json({
            success: true,
            data: { totalIssues: rows.length, byProductType, byTeam: byTeamArr, issues },
        });
    } catch (err) {
        console.error("ISSUES REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build issues report" });
    }
});

// SQL Server hard-caps a single request at 2100 parameters. Delivery
// volume is low today (~100 rows) but has no archival/limit, so batch
// the barcode lookup instead of binding one parameter per row — otherwise
// these reports start throwing 500s once deliveries pass ~2100.
const SQL_BARCODE_CHUNK_SIZE = 1000;
async function fetchUnoByBarcodeChunked(pool, barcodes, selectCols) {
    const rows = [];
    for (let i = 0; i < barcodes.length; i += SQL_BARCODE_CHUNK_SIZE) {
        const chunk = barcodes.slice(i, i + SQL_BARCODE_CHUNK_SIZE);
        const barcodeParams = chunk.map((_, j) => `@b${j}`).join(', ');
        const request = pool.request();
        chunk.forEach((b, j) => request.input(`b${j}`, b));
        const result = await request.query(
            `SELECT ${selectCols} FROM out WHERE barcode IN (${barcodeParams})`
        );
        rows.push(...result.recordset);
    }
    return rows;
}

/** ------------------------
 * GET Delivery-to-installation lag report
 * InsDelivered (MySQL) only stores a warehouse barcode, and installation
 * progress (instOrderItems/instOrderSteps, also MySQL) is tracked by unit
 * number, not barcode — the two are linked via the warehouse `out` table on
 * SQL Server (barcode -> UNO), so this requires bridging two separate
 * database engines rather than a single SQL join.
 * ------------------------ */
router.get('/reports/delivery-lag', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        const delivered = await sequelize2.query(
            `SELECT Insbarcode, InsDeliverdDate FROM IIT_Petra.InsDelivered WHERE Insbarcode IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        if (!delivered.length) {
            return res.json({ success: true, data: [] });
        }

        const barcodes = delivered.map(d => String(d.Insbarcode).trim());
        const stockRows = await withSqlRetry('minstock', (pool) => fetchUnoByBarcodeChunked(pool, barcodes, 'barcode, UNO'));
        const unoByBarcode = new Map(
            stockRows.map(r => [String(r.barcode).trim(), String(r.UNO ?? '').trim()])
        );

        const deliveredDateByUno = new Map();
        for (const d of delivered) {
            const uno = unoByBarcode.get(String(d.Insbarcode).trim());
            if (!uno) continue;
            const existing = deliveredDateByUno.get(uno);
            if (!existing || new Date(d.InsDeliverdDate) < new Date(existing)) {
                deliveredDateByUno.set(uno, d.InsDeliverdDate);
            }
        }

        // Earliest real activity (any material first scanned -- see
        // registerMaterialScan in services/instOrderComponents.js) per item
        // = when installation actually started for that unit.
        const items = await sequelizeUtf8.query(
            `
            SELECT
                iod.id AS instOrderItemId,
                m.unitIdDetail AS unitNo,
                io.order_number AS orderNumber,
                MIN(c.createdAt) AS firstActivity
            FROM IIT_Petra.instOrderItems iod
            JOIN IIT_Petra.InstOrderComponents c ON c.instOrderItemId = iod.id
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.instOrders io ON io.id = iod.instOrderId
            GROUP BY iod.id, m.unitIdDetail, io.order_number
            `,
            { type: QueryTypes.SELECT }
        );

        const { from, to } = req.query;
        const fromTime = from ? new Date(`${from} 00:00:00`).getTime() : null;
        const toTime = to ? new Date(`${to} 23:59:59`).getTime() : null;

        const data = items
            .map(it => {
                const uno = String(it.unitNo ?? '').trim();
                const deliveredDate = deliveredDateByUno.get(uno);
                if (!deliveredDate || !it.firstActivity) return null;
                const lagHours = Math.round((new Date(it.firstActivity) - new Date(deliveredDate)) / 3600000);
                return {
                    instOrderItemId: it.instOrderItemId,
                    unitNo: it.unitNo,
                    orderNumber: it.orderNumber,
                    deliveredDate,
                    installationStarted: it.firstActivity,
                    lagHours,
                };
            })
            .filter(Boolean)
            .filter(d => {
                const t = new Date(d.deliveredDate).getTime();
                if (fromTime !== null && t < fromTime) return false;
                if (toTime !== null && t > toTime) return false;
                return true;
            })
            .sort((a, b) => b.lagHours - a.lagHours);

        res.json({ success: true, data });
    } catch (err) {
        console.error("DELIVERY LAG REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build delivery lag report" });
    }
});

/** ------------------------
 * GET Delivery status report
 * For every item on an active installation order, shows whether it's been
 * delivered yet (matched via warehouse UNO -> InsDelivered barcode, same
 * matching approach as /reports/delivery-lag), aggregated per project and
 * per team so a manager can see delivery completion at a glance.
 * ------------------------ */
router.get('/reports/delivery-status', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        // Team names read correctly via sequelize2 but not through the
        // primary `sequelize` connection used below for `project` (same
        // per-table encoding inconsistency noted in /reports/checkin-checkout)
        // — fetch them separately and merge by id instead of joining.
        const teamRows = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams`,
            { type: QueryTypes.SELECT }
        );
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const items = await sequelize.query(
            `
            SELECT
                iod.id AS instOrderItemId,
                m.unitIdDetail AS unitNo,
                io.team_id AS teamId,
                j.projectNo AS projectNo,
                j.projectName AS projectName
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.instOrders io ON io.id = iod.instOrderId
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.project j ON j.projectId = m.projectId
            WHERE io.status != 'cancelled'
            `,
            { type: QueryTypes.SELECT }
        );

        const delivered = await sequelize2.query(
            `SELECT Insbarcode FROM IIT_Petra.InsDelivered WHERE Insbarcode IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );

        const deliveredUnoSet = new Set();
        if (delivered.length) {
            const barcodes = delivered.map(d => String(d.Insbarcode).trim());
            const stockRows = await withSqlRetry('minstock', (pool) => fetchUnoByBarcodeChunked(pool, barcodes, 'UNO'));
            stockRows.forEach(r => {
                const uno = String(r.UNO ?? '').trim();
                if (uno) deliveredUnoSet.add(uno);
            });
        }

        const byProject = new Map();
        const byTeam = new Map();

        for (const it of items) {
            const uno = String(it.unitNo ?? '').trim();
            const isDelivered = uno.length > 0 && deliveredUnoSet.has(uno);

            const projectKey = it.projectNo != null ? String(it.projectNo) : 'unknown';
            if (!byProject.has(projectKey)) {
                byProject.set(projectKey, {
                    projectNo: it.projectNo,
                    projectName: safeArabic(it.projectName) || `#${it.projectNo ?? 'unknown'}`,
                    total: 0,
                    delivered: 0,
                });
            }
            const p = byProject.get(projectKey);
            p.total++;
            if (isDelivered) p.delivered++;

            const teamKey = it.teamId != null ? String(it.teamId) : 'unassigned';
            if (!byTeam.has(teamKey)) {
                byTeam.set(teamKey, {
                    teamId: it.teamId,
                    teamName: teamNameById.get(it.teamId) || (it.teamId != null ? `Team ${it.teamId}` : 'Unassigned'),
                    total: 0,
                    delivered: 0,
                });
            }
            const t = byTeam.get(teamKey);
            t.total++;
            if (isDelivered) t.delivered++;
        }

        const finalize = (rows) =>
            rows.map(r => ({ ...r, pending: r.total - r.delivered }))
                .sort((a, b) => b.pending - a.pending);

        res.json({
            success: true,
            data: {
                byProject: finalize([...byProject.values()]),
                byTeam: finalize([...byTeam.values()]),
            },
        });
    } catch (err) {
        console.error("DELIVERY STATUS REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build delivery status report" });
    }
});

/** ------------------------
 * GET Daily activity report
 * On-demand snapshot of today's installation activity across all teams:
 * checkpoints, whether the team is currently on-site, steps completed, and
 * issues reported today. Accepts an optional ?date=YYYY-MM-DD to look at a
 * past day instead of today.
 * ------------------------ */
router.get('/reports/daily-activity', authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_REPORTS), async (req, res) => {
    try {
        const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.date || '') ? req.query.date : null;

        const teamRows = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams`,
            { type: QueryTypes.SELECT }
        );
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const checkpoints = await sequelize2.query(
            `
            SELECT cp.team_id, cp.checkpoint_type, cp.createdAt, io.order_number AS orderNumber
            FROM IIT_Petra.instTeamCheckpoints cp
            LEFT JOIN IIT_Petra.instOrders io ON io.id = cp.order_id
            WHERE DATE(cp.createdAt) = COALESCE(:date, CURDATE())
            ORDER BY cp.team_id, cp.createdAt ASC
            `,
            { replacements: { date: dateParam }, type: QueryTypes.SELECT }
        );

        // Component confirm/issue actions today, the InstOrderComponents
        // equivalent of the old instOrderStepUpdates-based query. Joined
        // straight through to instReqAssignments (same physical schema, see
        // config/db.js) since none of these columns need Arabic decoding.
        const componentUpdatesToday = await sequelizeUtf8.query(
            `
            SELECT c.status, ira.teamId
            FROM IIT_Petra.InstOrderComponents c
            JOIN IIT_Petra.instOrderItems iod ON iod.id = c.instOrderItemId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = iod.instOrderId
            WHERE DATE(c.updatedAt) = COALESCE(:date, CURDATE())
              AND c.status IN ('Installed', 'Issue')
            `,
            { replacements: { date: dateParam }, type: QueryTypes.SELECT }
        );

        const byTeam = new Map();
        const ensureTeam = (teamId) => {
            const key = teamId != null ? String(teamId) : 'unassigned';
            if (!byTeam.has(key)) {
                byTeam.set(key, {
                    teamId,
                    teamName: teamNameById.get(teamId) || (teamId != null ? `Team ${teamId}` : 'Unassigned'),
                    checkpointsToday: 0,
                    currentlyOnSite: false,
                    ordersVisitedToday: new Set(),
                    itemsCompletedToday: 0,
                    issuesReportedToday: 0,
                });
            }
            return byTeam.get(key);
        };

        const lastCheckpointByTeam = new Map();
        for (const cp of checkpoints) {
            const t = ensureTeam(cp.team_id);
            t.checkpointsToday++;
            if (cp.orderNumber != null) t.ordersVisitedToday.add(cp.orderNumber);
            lastCheckpointByTeam.set(cp.team_id, cp.checkpoint_type);
        }
        for (const [teamId, lastType] of lastCheckpointByTeam) {
            ensureTeam(teamId).currentlyOnSite = lastType === 'inProject';
        }

        for (const u of componentUpdatesToday) {
            const t = ensureTeam(u.teamId);
            if (u.status === 'Issue') t.issuesReportedToday++;
            else t.itemsCompletedToday++;
        }

        const data = [...byTeam.values()]
            .map(t => ({ ...t, ordersVisitedToday: t.ordersVisitedToday.size }))
            .sort((a, b) => b.checkpointsToday - a.checkpointsToday);

        res.json({ success: true, data, date: dateParam || new Date().toISOString().slice(0, 10) });
    } catch (err) {
        console.error("DAILY ACTIVITY REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build daily activity report" });
    }
});

export default router;
