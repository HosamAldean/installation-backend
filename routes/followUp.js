//backend/routes/followUp.js
import express from "express";
import { sequelize, sequelize2, getSqlPool } from "../config/db.js";
import { QueryTypes } from "sequelize";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { InstOrderStepUpdates, User, FollowUpNotes } from '../models/index.js';
import { notifyOrderUpdate } from './instOrders.js';

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
router.get('/my-orders', authenticateToken, async (req, res) => {
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
       ms.unitIdDetail As unitNo,
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
    if (reqUser.role === 'manager' || reqUser.role === 'admin') return true;
    const [stepTeamId, userTeamId] = await Promise.all([
        resolveTeamId(stepId),
        resolveTeamIdForUser(reqUser),
    ]);
    return !!userTeamId && userTeamId === stepTeamId;
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
router.post("/order-step/update", authenticateToken, upload.single("media"), async (req, res) => {
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

        try {
            // Send field news update for step status change
            const teamDetails = await sequelize2.query(
                `SELECT name FROM IIT_Petra.instTeams WHERE id = :teamId LIMIT 1`,
                { replacements: { teamId }, type: QueryTypes.SELECT }
            );
            const teamName = teamDetails[0]?.name;
            const itemDetails = await sequelize.query(`
                SELECT i.itemName, i.unitNo, p.projectNo, p.projectName, i.id as instOrderItemId
                FROM IIT_Petra.instOrderItems i
                LEFT JOIN IIT_Petra.instOrders o ON o.id = i.instOrderId
                LEFT JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = o.instReqMasterId
                LEFT JOIN IIT_Petra.project p ON p.projectId = m.projectId
                WHERE i.id = (SELECT instOrderItemId FROM IIT_Petra.instOrderSteps WHERE id = :stepId LIMIT 1)
                LIMIT 1
            `, { replacements: { stepId }, type: QueryTypes.SELECT });

            const item = itemDetails[0];
            const projectLabel = item?.projectNo ? `${item.projectNo} ${item.projectName || ''}`.trim() : (item?.projectName ?? undefined);
            const itemLabel = item?.unitNo ?? item?.itemName ?? undefined;

            // Get step name
            const stepDetails = await sequelize2.query(`
                SELECT i.stepName FROM IIT_Petra.instOrderSteps s
                JOIN IIT_Petra.instSteps i ON i.instStepId = s.instStepId
                WHERE s.id = :stepId LIMIT 1
            `, { replacements: { stepId }, type: QueryTypes.SELECT });

            const stepName = stepDetails[0]?.stepName || 'Step';

            console.log('[Field News] Sending update:', {
                stepId,
                stepName,
                status,
                teamName,
                projectLabel,
                itemLabel
            });

            notifyOrderUpdate({
                event: 'field_news',
                news: {
                    id: `update-${stepId}-${Date.now()}`,
                    type: 'update',
                    message: `${stepName} → ${status}`,
                    project: projectLabel,
                    item: itemLabel,
                    team: teamName,
                    status,
                    time: new Date().toISOString(),
                    photo: mediaUrl,
                    note: null,
                }
            });
            // Also broadcast a plain "something changed" event — unlike
            // /order-step/photo and /order-step/issue below, this route
            // never did this, so other managers' dashboards never
            // re-fetched orders after a step completed. Without that
            // refresh, detectChanges() on the frontend was comparing against
            // stale progress and could never notice an item crossing 100%,
            // so "completed" news entries silently never fired.
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
router.post("/order-step/issue", authenticateToken, upload.single("photo"), async (req, res) => {
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
router.post("/team/checkpoint", authenticateToken, async (req, res) => {
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
router.get('/team/locations', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
    try {
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
      ORDER BY t.name
      `,
            { type: QueryTypes.SELECT }
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
router.get('/team/online-status', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
    try {
        // InsUser.teamId is stale/unreliable (the JWT deliberately omits it —
        // see auth.js login) — the real team is resolved the same way every
        // other endpoint does it: instTeams.leader_emp_no = assignedEmpNo.
        const rows = await sequelize2.query(
            `
            SELECT t.id AS team_id, MAX(u.isOnline) AS isOnline, MAX(u.lastSeenAt) AS lastSeenAt
            FROM IIT_Petra.InsUser u
            JOIN IIT_Petra.instTeams t ON t.leader_emp_no = u.assignedEmpNo
            GROUP BY t.id
            `,
            { type: QueryTypes.SELECT }
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
router.get('/team/history/:teamId', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
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

        if (req.user.role !== 'manager' && req.user.role !== 'admin') {
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
router.get("/scan-basic/:barcode", authenticateToken, async (req, res) => {
    try {
        const { barcode } = req.params;

        if (!barcode) {
            return res.status(400).json({
                success: false,
                status: "NOT_FOUND",
                message: "Barcode required"
            });
        }

        const empNo = req.user.assignedEmpNo;

        const pool = await getSqlPool("minstock");

        const stockResult = await pool.request()
            .input("barcode", barcode)
            .query(`
                SELECT TOP 1 *
                FROM out
                WHERE barcode = @barcode
            `);

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

// GET /api/follow-up/delivered-items
router.get('/delivered-items', authenticateToken, async (req, res) => {
    try {
        const assignedEmpNo = req.user.assignedEmpNo;

        if (!assignedEmpNo) {
            return res.status(400).json({
                success: false,
                message: 'No assignedEmpNo on token'
            });
        }

        // ===============================
        // PROJECTS
        // ===============================
        const projRows = await sequelize.query(
            `
            SELECT DISTINCT
                SUBSTRING_INDEX(j.projectNo, '-', 1) AS projectNo,
                j.projectName
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
                replacements: { assignedEmpNo },
                type: QueryTypes.SELECT,
            }
        );

        if (!projRows.length) {
            return res.json({ success: true, data: [] });
        }

        const projectMap = new Map();

        projRows.forEach((p) => {
            const key = normalizeProjectNo(p.projectNo);

            projectMap.set(key, {
                projectNo: key,
                projectName: safeArabic(p.projectName),
            });
        });

        const projectNos = [...projectMap.keys()].slice(0, 200);

        const quoted = projectNos
            .map(p => `'${p.replace(/'/g, "''")}'`)
            .join(',');

        // ===============================
        // MINSTOCK DATA
        // ===============================
        const pool = await getSqlPool('minstock');

        const result = await pool.request().query(`
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
        `);

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

        res.json({ success: true, data: merged });

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
    const cleanBarcode = String(barcode).trim();
    const pool = await getSqlPool("minstock");

    const stockResult = await pool.request()
        .input('barcode', cleanBarcode)
        .query(`SELECT TOP 1 projNo FROM out WHERE barcode = @barcode`);

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
router.post("/delivery-status", authenticateToken, uploadDeliveryPhoto.single("photo"), async (req, res) => {
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
            return res.status(400).json({ success: false, message: "No team assigned to this user" });
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
router.get('/reports/checkin-checkout', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
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

        // `completedAt` exists on instOrderSteps but nothing in this codebase
        // ever writes to it (step-status updates only set `updatedAt`), so it
        // stays NULL forever — use `updatedAt` + status instead as the real
        // completion signal.
        const orderIds = [...new Set(checkpoints.map(c => c.order_id))];
        const completedSteps = orderIds.length
            ? await sequelize.query(
                `
                SELECT iod.instOrderId AS orderId, s.updatedAt AS completedAt,
                       COALESCE(st.standardTime, 0) AS standardTime
                FROM IIT_Petra.instOrderSteps s
                JOIN IIT_Petra.instOrderItems iod ON iod.id = s.instOrderItemId
                LEFT JOIN IIT_Petra.instSteps st ON st.instStepId = s.instStepId
                WHERE iod.instOrderId IN (:orderIds) AND LOWER(s.status) = 'completed'
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
                    const stepsInWindow = completedSteps.filter(
                        s => s.orderId === ev.order_id &&
                            new Date(s.completedAt) >= checkIn &&
                            new Date(s.completedAt) <= checkOut
                    );
                    const itemsCompleted = stepsInWindow.length;
                    const standardMinutes = Math.round(
                        stepsInWindow.reduce((sum, s) => sum + Number(s.standardTime || 0), 0)
                    );
                    const durationMinutes = Math.round((checkOut - checkIn) / 60000);
                    // Efficiency = standard (expected) time / actual time on-site.
                    // >100% means faster than standard, <100% means slower. Null
                    // when nothing was completed, since the ratio is meaningless.
                    const efficiencyPercent = itemsCompleted > 0 && durationMinutes > 0
                        ? Math.round((standardMinutes / durationMinutes) * 100)
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
                        standardMinutes,
                        efficiencyPercent,
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

/** ------------------------
 * GET Issue/rework frequency report
 * Aggregates instOrderStepUpdates rows with status='Issue' by step type
 * (which step design/training tends to cause problems) and by team (which
 * teams report issues disproportionately).
 * ------------------------ */
router.get('/reports/issues', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
    try {
        // sequelize2 (not the primary sequelize connection) reads Arabic
        // text from instSteps correctly — same inconsistent per-table
        // encoding as elsewhere in this legacy DB (see resolveTeamIdForUser
        // and the checkin-checkout report for the same pattern).
        // A single "report issue" submit from the mobile app has, at least
        // historically, sometimes written several identical
        // instOrderStepUpdates rows for the same step+moment (same
        // problem_note/createdAt down to the second) — a client-side
        // duplicate-submit bug, not several real reports. Group by
        // step+timestamp so those collapse into one card, while genuinely
        // separate issue reports on the same step at different times (a
        // worker reports, it gets fixed, then a new problem shows up later)
        // still show as distinct entries.
        const { from, to } = req.query;
        const dateFilter = [];
        const replacements = {};
        if (from) { dateFilter.push('u.createdAt >= :from'); replacements.from = `${from} 00:00:00`; }
        if (to) { dateFilter.push('u.createdAt <= :to'); replacements.to = `${to} 23:59:59`; }
        const dateWhere = dateFilter.length ? ` AND ${dateFilter.join(' AND ')}` : '';

        const rows = await sequelize2.query(
            `
            SELECT
                MIN(u.id) AS id,
                MIN(u.problem_note) AS problem_note,
                u.createdAt,
                MIN(st.stepName) AS stepName,
                MIN(ira.teamId) AS teamId,
                MIN(io.order_number) AS orderNumber,
                MIN(m.unitIdDetail) AS unitNo,
                MIN(s.status) AS currentStepStatus,
                MIN(u.image_before) AS photo
            FROM IIT_Petra.instOrderStepUpdates u
            JOIN IIT_Petra.instOrderSteps s ON s.id = u.instOrderStepId
            LEFT JOIN IIT_Petra.instSteps st ON st.instStepId = s.instStepId
            JOIN IIT_Petra.instOrderItems iod ON iod.id = s.instOrderItemId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = iod.instOrderId
            LEFT JOIN IIT_Petra.instOrders io ON io.id = iod.instOrderId
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            WHERE LOWER(u.status) = 'issue'${dateWhere}
            GROUP BY s.id, u.createdAt
            ORDER BY u.createdAt DESC
            `,
            { type: QueryTypes.SELECT, replacements }
        );

        const teamRows = await sequelize2.query(`SELECT id, name FROM IIT_Petra.instTeams`, { type: QueryTypes.SELECT });
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const byStep = new Map();
        const byTeam = new Map();
        for (const r of rows) {
            const stepName = fixArabic(r.stepName) || 'Unknown step';
            byStep.set(stepName, (byStep.get(stepName) || 0) + 1);

            if (r.teamId) {
                const teamName = teamNameById.get(r.teamId) || `Team ${r.teamId}`;
                const key = `${r.teamId}|${teamName}`;
                byTeam.set(key, (byTeam.get(key) || 0) + 1);
            }
        }

        const byStepType = Array.from(byStep.entries())
            .map(([stepName, count]) => ({ stepName, count }))
            .sort((a, b) => b.count - a.count);

        const byTeamArr = Array.from(byTeam.entries())
            .map(([key, count]) => {
                const [teamId, teamName] = key.split('|');
                return { teamId: Number(teamId), teamName, count };
            })
            .sort((a, b) => b.count - a.count);

        // Follow-up notes managers have attached to these issues — merged in
        // here so the frontend can render each issue with its note (if any)
        // in a single request.
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

        const allIssues = rows.map(r => {
            const note = noteByIssueId.get(r.id);
            // The step's CURRENT status (not this update's status, which is
            // always 'issue' by the WHERE clause above) — if the worker has
            // since redone the step and it's no longer 'issue', the problem
            // has been fixed in the field and this moves to history instead
            // of sitting in the active follow-up list forever.
            const fixedByWorker = !!r.currentStepStatus && String(r.currentStepStatus).toLowerCase() !== 'issue';
            return {
                issueId: r.id,
                problemNote: fixArabic(r.problem_note),
                createdAt: r.createdAt,
                stepName: fixArabic(r.stepName) || 'Unknown step',
                teamId: r.teamId,
                teamName: r.teamId ? teamNameById.get(r.teamId) || `Team ${r.teamId}` : null,
                orderNumber: r.orderNumber,
                unitNo: r.unitNo,
                photo: r.photo || null,
                fixedByWorker,
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

        const issues = allIssues.filter(i => !i.fixedByWorker);
        const historyIssues = allIssues.filter(i => i.fixedByWorker);

        res.json({
            success: true,
            data: { totalIssues: rows.length, byStepType, byTeam: byTeamArr, issues, historyIssues },
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
router.get('/reports/delivery-lag', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
    try {
        const delivered = await sequelize2.query(
            `SELECT Insbarcode, InsDeliverdDate FROM IIT_Petra.InsDelivered WHERE Insbarcode IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        if (!delivered.length) {
            return res.json({ success: true, data: [] });
        }

        const barcodes = delivered.map(d => String(d.Insbarcode).trim());
        const pool = await getSqlPool('minstock');
        const stockRows = await fetchUnoByBarcodeChunked(pool, barcodes, 'barcode, UNO');
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

        // Earliest real activity (any step update) per item = when
        // installation actually started for that unit.
        const items = await sequelize2.query(
            `
            SELECT
                iod.id AS instOrderItemId,
                m.unitIdDetail AS unitNo,
                io.order_number AS orderNumber,
                MIN(u.createdAt) AS firstActivity
            FROM IIT_Petra.instOrderItems iod
            JOIN IIT_Petra.instOrderSteps s ON s.instOrderItemId = iod.id
            JOIN IIT_Petra.instOrderStepUpdates u ON u.instOrderStepId = s.id
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
 * GET Standard-time calibration report
 * Flags step types where the real-world time chronically over/under-shoots
 * instSteps.standardTime, to help correct bad estimates.
 *
 * There's no reliable "work started" timestamp per step (assignedAt is
 * never populated, and most steps only ever get a single "completed"
 * update — no in_progress tracking in practice), so true per-step duration
 * isn't directly measurable. Instead this uses the time gap between
 * consecutive step completions within the same item (ordered by
 * stepOrder) as a defensible proxy for how long each step actually took.
 * ------------------------ */
router.get('/reports/standard-time-calibration', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
    try {
        const { from, to } = req.query;
        const dateFilter = [];
        const replacements = {};
        if (from) { dateFilter.push('s.updatedAt >= :from'); replacements.from = `${from} 00:00:00`; }
        if (to) { dateFilter.push('s.updatedAt <= :to'); replacements.to = `${to} 23:59:59`; }
        const dateWhere = dateFilter.length ? ` AND ${dateFilter.join(' AND ')}` : '';

        const rows = await sequelize2.query(
            `
            SELECT
                s.instOrderItemId,
                s.stepOrder,
                s.updatedAt,
                st.stepName,
                st.standardTime
            FROM IIT_Petra.instOrderSteps s
            LEFT JOIN IIT_Petra.instSteps st ON st.instStepId = s.instStepId
            WHERE LOWER(s.status) IN ('completed', 'done')${dateWhere}
            ORDER BY s.instOrderItemId, s.stepOrder ASC
            `,
            { type: QueryTypes.SELECT, replacements }
        );

        const byItem = new Map();
        for (const r of rows) {
            if (!byItem.has(r.instOrderItemId)) byItem.set(r.instOrderItemId, []);
            byItem.get(r.instOrderItemId).push(r);
        }

        const samplesByStep = new Map(); // stepName -> { standardTime, actualMinutes: [] }
        for (const steps of byItem.values()) {
            for (let i = 1; i < steps.length; i++) {
                const prev = steps[i - 1];
                const cur = steps[i];
                const gapMinutes = (new Date(cur.updatedAt) - new Date(prev.updatedAt)) / 60000;
                // Skip non-positive/implausibly large gaps (batch imports,
                // multiple steps closed in the same click, days-long gaps
                // from a paused job) — keep this a sane same-session signal.
                if (gapMinutes <= 0 || gapMinutes > 8 * 60) continue;

                const stepName = fixArabic(cur.stepName) || 'Unknown step';
                if (!samplesByStep.has(stepName)) {
                    samplesByStep.set(stepName, { standardTime: Number(cur.standardTime) || 0, actualMinutes: [] });
                }
                samplesByStep.get(stepName).actualMinutes.push(gapMinutes);
            }
        }

        const data = Array.from(samplesByStep.entries())
            .map(([stepName, { standardTime, actualMinutes }]) => {
                const avgActual = actualMinutes.reduce((s, v) => s + v, 0) / actualMinutes.length;
                return {
                    stepName,
                    standardTime,
                    avgActualMinutes: Math.round(avgActual),
                    sampleSize: actualMinutes.length,
                    ratioPercent: standardTime > 0 ? Math.round((avgActual / standardTime) * 100) : null,
                };
            })
            // A single sample is too noisy to draw a calibration conclusion from.
            .filter(d => d.sampleSize >= 3 && d.standardTime > 0)
            .sort((a, b) => Math.abs((b.ratioPercent ?? 100) - 100) - Math.abs((a.ratioPercent ?? 100) - 100));

        res.json({ success: true, data });
    } catch (err) {
        console.error("STANDARD TIME CALIBRATION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to build calibration report" });
    }
});

/** ------------------------
 * GET Delivery status report
 * For every item on an active installation order, shows whether it's been
 * delivered yet (matched via warehouse UNO -> InsDelivered barcode, same
 * matching approach as /reports/delivery-lag), aggregated per project and
 * per team so a manager can see delivery completion at a glance.
 * ------------------------ */
router.get('/reports/delivery-status', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
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
            const pool = await getSqlPool('minstock');
            const stockRows = await fetchUnoByBarcodeChunked(pool, barcodes, 'UNO');
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
router.get('/reports/daily-activity', authenticateToken, authorizeRoles('manager', 'admin'), async (req, res) => {
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

        const stepUpdatesToday = await sequelize2.query(
            `
            SELECT u.status, ira.teamId
            FROM IIT_Petra.instOrderStepUpdates u
            JOIN IIT_Petra.instOrderSteps s ON s.id = u.instOrderStepId
            JOIN IIT_Petra.instOrderItems iod ON iod.id = s.instOrderItemId
            LEFT JOIN IIT_Petra.instReqAssignments ira
                ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = iod.instOrderId
            WHERE DATE(u.createdAt) = COALESCE(:date, CURDATE())
              AND LOWER(u.status) IN ('completed', 'done', 'issue')
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
                    stepsCompletedToday: 0,
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

        for (const u of stepUpdatesToday) {
            const t = ensureTeam(u.teamId);
            const status = String(u.status).toLowerCase();
            if (status === 'issue') t.issuesReportedToday++;
            else t.stepsCompletedToday++;
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
