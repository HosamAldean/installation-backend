// backend/routes/installationRequests.js
import express from 'express';
import { sequelize, sequelize2 } from '../config/db.js';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
// This entire router previously had no authentication at all — contract
// values, project addresses, and request/assignment mutation were reachable
// by anyone with network access. The frontend (InstallationRequests.tsx) is
// already gated to manager/admin via RoleProtectedRoute — mirror that here
// so it can't be bypassed by calling the API directly, matching instOrders.js.
router.use(authenticateToken);
router.use(authorizeRoles('installation_manager', 'admin'));

/** -------------------------------------------------------
 *  🔧 Arabic Auto-Recovery (Fix double-encoded UTF-8 text)
 * -------------------------------------------------------- */
const fixArabic = (str) => {
    if (!str || typeof str !== 'string') return str;
    try {
        const buf = Buffer.from(str, 'binary');
        const utf = buf.toString('utf8');
        if (/[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي]/.test(utf)) return utf;
        return str;
    } catch {
        return str;
    }
};

const fixArabicFields = (row) => {
    if (!row) return row;
    const arabicFields = ['projectName', 'address', 'notes', 'statusNotes', 'itemName', 'profileSectionName','descAr'];
    arabicFields.forEach((key) => {
        if (row[key]) row[key] = fixArabic(row[key]);
    });
    return row;
};

/**
 * ===========================================================
 *  ✅ 1) Get all installation requests (masters)
 * ===========================================================
 */
router.get('/', async (req, res) => {
    try {
        let requests = await sequelize.query(
            `
            SELECT 
                m.instReqMasterId,
                m.projectId,
                m.reqNo,
                m.reqDate,
                m.reqStatusId,
                p.projectNo,
                p.projectName,
                p.address,
                p.contractValue,
                p.progress,
                p.statusId
            FROM IIT_Petra.instReqMaster m
            LEFT JOIN IIT_Petra.project p 
                ON m.projectId = p.projectId
            ORDER BY m.reqDate DESC
            `,
            { type: QueryTypes.SELECT }
        );

        requests = requests.map(fixArabicFields);
        res.json({ success: true, data: requests });
    } catch (err) {
        console.error("❌ Error loading installation requests:", err.stack || err);
        res.status(500).json({ success: false, message: 'Server error fetching installation requests' });
    }
});
        // GET: All installation request statuses
        router.get('/status/list', async (req, res) => {
            try {
                const rows = await sequelize2.query(
                    `SELECT instReqStatusId, instReqStatusName, instReqStatusDesc 
                     FROM instReqStatus`,
                    { type: QueryTypes.SELECT }
                );

                res.json({ success: true, data: rows });
            } catch (err) {
                console.error("Error loading statuses:", err);
                res.status(500).json({ success: false, message: "Failed to load statuses" });
            }
        });

/**
 * ===========================================================
 *  ✅ 2) Get a single installation request (master + details)
 * ===========================================================
 */
router.get('/:reqId', async (req, res) => {
    try {
        const { reqId } = req.params;

        // 1. Fetch the request master
        let master = await sequelize.query(
            `
            SELECT 
                m.*,
                p.projectNo,
                p.projectName,
                p.address,
                p.contractValue,
                p.progress,
                p.notes,
                p.statusNotes
            FROM IIT_Petra.instReqMaster m
            LEFT JOIN IIT_Petra.project p 
                ON m.projectId = p.projectId
            WHERE m.instReqMasterId = :reqId
            `,
            { replacements: { reqId }, type: QueryTypes.SELECT }
        );

        if (!master.length) return res.json({ success: true, data: null });
        master[0] = fixArabicFields(master[0]);

        // 2. Fetch the details
        let details = await sequelize.query(
            `SELECT * FROM IIT_Petra.instReqDet WHERE instReqMasterId = :reqId`,
            { replacements: { reqId }, type: QueryTypes.SELECT }
        );

        details = details.map(d => ({
            ...d,
            itemName: fixArabic(d.itemName),
            notes: fixArabic(d.notes)
        }));

        // 3. Fetch related masterControl rows by instReqDet.rowId
        const rowIds = details.map(d => d.rowId).filter(Boolean);
        let masterControls = [];
        if (rowIds.length > 0) {
            masterControls = await sequelize.query(
                `
                SELECT m.*, o.orderNumber, p.profileSectionName
                FROM IIT_Petra.masterControl m
                LEFT JOIN IIT_Petra.orders o
                    ON m.orderId = o.orderId
                LEFT JOIN IIT_Petra.profileSection p
                    ON m.profileSectionId = p.profileSectionId
                WHERE m.rowId IN (:rowIds)
                `,
                { replacements: { rowIds }, type: QueryTypes.SELECT }
            );
            masterControls = masterControls.map(fixArabicFields);
        }

        // 4. Merge masterControl data into details
        const detailsWithControl = details.map(d => {
            const control = masterControls.find(c => c.rowId === d.rowId);
            return { ...d, masterControl: control || null };
        });

        res.json({
            success: true,
            data: {
                master: master[0],
                details: detailsWithControl
            }
        });
    } catch (err) {
        console.error("❌ Error fetching installation request:", err.stack || err);
        res.status(500).json({ success: false, message: 'Server error fetching installation request' });
    }
});

/**
 * ===========================================================
 *  ✅ 3) Get request items with assigned status
 * ===========================================================
 */
router.get('/:reqId/items', async (req, res) => {
    try {
        const { reqId } = req.params;

        const items = await sequelize2.query(
            `
            SELECT 
                d.rowId,
                d.itemName,
                d.qty,
                i.id AS instOrderItemId
            FROM IIT_Petra.instReqDet d
            LEFT JOIN IIT_Petra.instOrderItems i ON i.rowId = d.rowId
            WHERE d.instReqMasterId = :reqId
            ORDER BY d.instReqDetId ASC
            `,
            { replacements: { reqId }, type: QueryTypes.SELECT }
        );

        const mapped = items.map(d => ({
            rowId: d.rowId,
            itemName: fixArabic(d.itemName),
            qty: d.qty || 1,
            assigned: !!d.instOrderItemId,
            instOrderItemId: d.instOrderItemId || null
        }));

        res.json({ success: true, data: mapped });
    } catch (err) {
        console.error("❌ Error fetching request items:", err.stack || err);
        res.status(500).json({ success: false, message: 'Server error fetching request items' });
    }
});

/**
 * ===========================================================
 *  ✅ 4) GROUPED ITEMS + Teams + Availability
 * ===========================================================
 */
router.get('/grouped/:reqId', async (req, res) => {
    try {
        const { reqId } = req.params;

        // details + master control + profile section + order number (if exists)
        const details = await sequelize.query(
            `
            SELECT
                d.instReqDetId,
                d.instReqMasterId,
                d.rowId,
                COALESCE(p.profileSectionName, '') AS profileSectionName,
                COALESCE(s.descAr, '') AS itemName,
                '1' as qty,
                m.unitIdContract AS unitNo,
                m.height,
                m.width,
                m.orderId,
                o.orderNumber AS orderNumber
            FROM IIT_Petra.instReqDet d
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = d.rowId
			LEFT JOIN IIT_Petra.unitShapes s ON m.unitShapeId = s.unitShapeId
            LEFT JOIN IIT_Petra.orders o ON m.orderId = o.orderId
            LEFT JOIN IIT_Petra.profileSection p ON m.profileSectionId = p.profileSectionId
            WHERE d.instReqMasterId =  :reqId
            ORDER BY COALESCE(p.profileSectionName, ''), d.instReqDetId
            `,
            { replacements: { reqId }, type: QueryTypes.SELECT }
        );

        // apply Arabic fixes for profile names & item names
        const detailsFixed = details.map(d => fixArabicFields(d));

        const rowIds = detailsFixed.map(d => d.rowId).filter(Boolean);
        let assignedRows = [];
        if (rowIds.length) {
            assignedRows = await sequelize2.query(
                `SELECT i.rowId, i.instOrderId,o.id, t.name AS instOrderItemId
                FROM IIT_Petra.instOrderItems i
                LEFT JOIN IIT_Petra.instOrders o ON i.instOrderId = o.id
                LEFT JOIN IIT_Petra.instTeams t ON o.team_id = t.id
                WHERE rowId IN (:rowIds)`,
                { replacements: { rowIds }, type: QueryTypes.SELECT }
            );
        }

        const assignedMap = {};
        assignedRows.forEach(r => {
            assignedMap[r.rowId] = r;
        });

        const grouped = {};
        detailsFixed.forEach(d => {
            const section = d.profileSectionName || 'Uncategorized';
            if (!grouped[section]) grouped[section] = [];
            if (!d.rowId) return;

            const assignedInfo = assignedMap[d.rowId];
            grouped[section].push({
                instReqDetId: d.instReqDetId,
                rowId: d.rowId,
                // itemName was already decoded once by fixArabicFields()
                // above — re-running fixArabic() on already-correct UTF-8
                // risks the same double-decode corruption this helper exists
                // to fix elsewhere in the codebase.
                itemName: d.itemName || '',
                qty: d.qty || 1,
                unitNo: d.unitNo,
                height: d.height,
                width: d.width,
                orderId: d.orderId,
                orderNumber: d.orderNumber,
                assigned: !!assignedInfo,
                assignment: assignedInfo
                    ? { instOrderItemId: assignedInfo.instOrderItemId, instOrderId: assignedInfo.instOrderId }
                    : null
            });
        });

        // teams
        const teams = await sequelize2.query(
            `SELECT id, name, description FROM IIT_Petra.instTeams ORDER BY id DESC`,
            { type: QueryTypes.SELECT }
        );

        // availability: counts by team and status from instOrders table
        const availability = await sequelize2.query(
            `SELECT team_id AS teamId, status, COUNT(*) AS cnt FROM IIT_Petra.instOrders WHERE status IN ('pending','in_progress') GROUP BY team_id, status`,
            { type: QueryTypes.SELECT }
        );

        const teamAvailability = {};
        availability.forEach(r => {
            const id = r.teamId;
            if (!teamAvailability[id]) teamAvailability[id] = { pending: 0, in_progress: 0 };
            if (r.status === 'pending') teamAvailability[id].pending = Number(r.cnt);
            if (r.status === 'in_progress') teamAvailability[id].in_progress = Number(r.cnt);
            teamAvailability[id].total = (teamAvailability[id].pending || 0) + (teamAvailability[id].in_progress || 0);
        });

        // apply fixArabic to team names as well
        const teamsFixed = teams.map(t => ({ ...t, name: fixArabic(t.name) }));

        res.json({ success: true, data: { grouped, teams: teamsFixed, teamAvailability } });
    } catch (err) {
        console.error('❌ Error loading grouped items:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * ===========================================================
 *  ✅ 5) Assign items to a team (fixed to create instOrders + instOrderItems)
 * ===========================================================
 */
router.post('/:reqId/assign', async (req, res) => {
    try {
        const { reqId } = req.params;
        const { teamId, itemIds } = req.body;

        if (!teamId || !Array.isArray(itemIds) || itemIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid input' });
        }

        const trx = await sequelize.transaction();

        try {
            for (const rowId of itemIds) {

                // 1️⃣ Check if already assigned
                const exists = await sequelize.query(
                    `SELECT instOrderItemId FROM IIT_Petra.instOrderItems WHERE rowId = :rowId`,
                    { replacements: { rowId }, type: QueryTypes.SELECT, transaction: trx }
                );
                if (exists.length) continue;

                // 2️⃣ Create an order (if not exists)
                const [orderResult] = await sequelize.query(
                    `INSERT INTO IIT_Petra.instOrders (team_id, status, assigned_date)
                     VALUES (:teamId, 'pending', NOW())`,
                    { replacements: { teamId }, transaction: trx }
                );
                const instOrderId = orderResult.insertId;

                // 3️⃣ Create instOrderItem linked to rowId
                await sequelize.query(
                    `INSERT INTO IIT_Petra.instOrderItems (instOrderId, rowId)
                     VALUES (:instOrderId, :rowId)`,
                    {
                        replacements: { instOrderId, rowId },
                        transaction: trx
                    }
                );

                // 4️⃣ Update master detail row
                await sequelize.query(
                    `UPDATE IIT_Petra.instReqDet 
                     SET assignedTeamId = :teamId 
                     WHERE rowId = :rowId`,
                    { replacements: { rowId, teamId }, transaction: trx }
                );
            }

            await trx.commit();
            res.json({ success: true, message: "Items assigned successfully" });

        } catch (err) {
            await trx.rollback();
            throw err;
        }

    } catch (err) {
        console.error("❌ Assign error:", err);
        res.status(500).json({ success: false, message: "Server error during assign" });
    }
});


/**
 * ===========================================================
 *  ✅ 6) Create new installation request (Master only)
 * ===========================================================
 */
router.post('/', async (req, res) => {
    try {
        const { projectId, reqNo, reqDate, reqStatusId } = req.body;

        if (!projectId || !reqNo) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const result = await sequelize.query(
            `
            INSERT INTO IIT_Petra.instReqMaster (projectId, reqNo, reqDate, reqStatusId)
            OUTPUT inserted.instReqMasterId
            VALUES (:projectId, :reqNo, :reqDate, :reqStatusId)
            `,
            { replacements: { projectId, reqNo, reqDate, reqStatusId }, type: QueryTypes.INSERT }
        );

        const masterId = result[0][0]?.instReqMasterId || null;

        res.json({ success: true, masterId });
    } catch (err) {
        console.error("❌ Error creating installation request:", err);
        res.status(500).json({ success: false, message: 'Server error creating installation request' });
    }
});

/**
 * ===========================================================
 *  ✅ 7) Add installation request details (BULK insert)
 * ===========================================================
 */
router.post('/:reqId/details', async (req, res) => {
    try {
        const { reqId } = req.params;
        const { details } = req.body;

        if (!Array.isArray(details) || details.length === 0) {
            return res.status(400).json({ success: false, message: 'Details must be an array' });
        }

        for (const d of details) {
            await sequelize.query(
                `INSERT INTO IIT_Petra.instReqDet (instReqMasterId, itemName, qty, notes)
                 VALUES (:instReqMasterId, :itemName, :qty, :notes)`,
                { replacements: { instReqMasterId: reqId, itemName: d.itemName, qty: d.qty || 0, notes: d.notes || '' } }
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Error inserting installation request details:", err);
        res.status(500).json({ success: false, message: 'Server error adding request details' });
    }
});

/**
 * ===========================================================
 *  ✅ 8) Delete installation request (master + details)
 * ===========================================================
 */
router.delete('/:reqId', async (req, res) => {
    try {
        const { reqId } = req.params;

        await sequelize.query(`DELETE FROM IIT_Petra.instReqDet WHERE instReqMasterId = :reqId`, { replacements: { reqId } });
        await sequelize.query(`DELETE FROM IIT_Petra.instReqMaster WHERE instReqMasterId = :reqId`, { replacements: { reqId } });

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Error deleting installation request:", err);
        res.status(500).json({ success: false, message: 'Server error deleting installation request' });
    }
});


export default router;
