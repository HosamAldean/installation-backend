import express from 'express';
import { sequelize, sequelize2, sequelize3 } from '../config/db.js';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
// Every route in this file operates on order/project data and previously had
// no authentication at all — require a valid token for all of them. All
// endpoints here are only ever called from the manager-facing web dashboard
// (ManageOrdersPage/reports.tsx via useOrders.ts), which the frontend
// already gates to manager/admin (see router.tsx) — this mirrors that same
// restriction on the backend so it can't be bypassed by calling the API directly.
router.use(authenticateToken);
router.use(authorizeRoles('installation_manager', 'admin'));

const ARABIC_RE = /[اأإآابتثجحخدذرزسشصضطظعغفقكلمنهوي]/;
const fixArabic = (str) => {
    if (!str || typeof str !== 'string') return str;
    // already contains arabic letters => assume ok
    if (ARABIC_RE.test(str)) return str;
    try {
        // try decoding from latin1 (safe alternative to 'binary')
        const converted = Buffer.from(str, 'latin1').toString('utf8');
        if (ARABIC_RE.test(converted)) return converted;
    } catch (e) {
        // ignore and fallthrough
    }
    // fallback: remove control / non-printable chars that may cause mojibake
    try {
        return str.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
    } catch {
        return str;
    }
};

const fixArabicFields = (row) => {
    if (!row) return row;
    const arabicFields = ['descAr'];
    arabicFields.forEach((key) => {
        if (row[key]) row[key] = fixArabic(row[key]);
    });
    return row;
};
/* -------------------------------------------------------------
   1) GET GROUPED REQUEST ITEMS (FOR INSTALLATION PAGE)
-------------------------------------------------------------*/
router.get('/grouped/:reqId', async (req, res) => {
    try {
        const { reqId } = req.params;

        const details = await sequelize.query(`
            SELECT 
                d.instReqDetId,
                d.rowId,
                COALESCE(p.profileSectionName, '') AS sectionName,
                s.descAr AS itemName,
                1 AS qty,
                m.unitIdContract,
                m.unitIdDetail As unitNo,
                m.height,
                m.width,
                m.orderId,
                oi.orderNumber,
                m.unitShapeId                      -- ✅ FIX 1
            FROM IIT_Petra.instReqDet d
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = d.rowId
            LEFT JOIN IIT_Petra.unitShapes s ON m.unitShapeId = s.unitShapeId
            
            LEFT JOIN IIT_Petra.profileSection p ON m.profileSectionId = p.profileSectionId
            LEFT JOIN IIT_Petra.orders oi ON m.orderId = oi.orderId
            WHERE d.instReqMasterId = :reqId
            ORDER BY COALESCE(p.profileSectionName, ''), d.instReqDetId
        `, { replacements: { reqId }, type: QueryTypes.SELECT });

        const detIds = details.map(d => d.instReqDetId).filter(Boolean);

        const assignments = detIds.length
            ? await sequelize2.query(`
                SELECT 
                    a.id AS assignmentId,
                    a.instReqDetId,
                    a.instOrderId,
                    i.id as instOrderItemId,              -- ✅ FIX 3
                    a.teamId,
                    a.progressStatus,
                    a.progressPercent
                FROM IIT_Petra.instReqAssignments a
                LEFT JOIN IIT_Petra.instOrderItems i
                    ON i.instOrderId = a.instOrderId AND i.instReqDetId = a.instReqDetId
                WHERE a.instReqDetId IN (:ids)
            `, { replacements: { ids: detIds }, type: QueryTypes.SELECT })
            : [];

        const assignmentMap = {};
        assignments.forEach(a => { assignmentMap[a.instReqDetId] = a; });

        const grouped = {};
        details.forEach(d => {
            const section = d.sectionName || 'Uncategorized';
            if (!grouped[section]) grouped[section] = [];

            const assignment = assignmentMap[d.instReqDetId] || null;

            grouped[section].push({
                instReqDetId: d.instReqDetId,
                rowId: d.rowId,
                itemName: fixArabic(d.itemName),
                qty: d.qty,
                unitIdContract: d.unitIdContract,
                unitNo: d.unitNo,
                height: d.height,
                width: d.width,
                orderId: d.orderId,
                orderNumber: d.orderNumber,
                unitShapeId: d.unitShapeId,          // ✅ FIXED
                assigned: !!assignment,
                assignment: assignment
                    ? {
                        id: assignment.assignmentId,
                        instOrderItemId: assignment.instOrderItemId,
                        instOrderId: assignment.instOrderId,
                        unitShapeId: d.unitShapeId,   // ❗ now exists
                        teamId: assignment.teamId,
                        progressStatus: assignment.progressStatus,
                        progressPercent: assignment.progressPercent,
                    }
                    : null,
            });
        });



        const teams = await sequelize2.query(`
            SELECT id, name, description FROM IIT_Petra.instTeams ORDER BY id DESC
        `, { type: QueryTypes.SELECT });

        // Team availability
        const availabilityRows = await sequelize2.query(`
            SELECT teamId, progressStatus, COUNT(*) AS cnt
            FROM IIT_Petra.instReqAssignments
            WHERE progressStatus IN ('Pending','In Progress')
            GROUP BY teamId, progressStatus
        `, { type: QueryTypes.SELECT });

        const teamAvailability = {};
        availabilityRows.forEach(r => {
            if (!teamAvailability[r.teamId]) teamAvailability[r.teamId] = { pending: 0, in_progress: 0, total: 0 };
            if (r.progressStatus === 'Pending') teamAvailability[r.teamId].pending = Number(r.cnt);
            if (r.progressStatus === 'In Progress') teamAvailability[r.teamId].in_progress = Number(r.cnt);
            teamAvailability[r.teamId].total = (teamAvailability[r.teamId].pending || 0) + (teamAvailability[r.teamId].in_progress || 0);
        });

        res.json({ success: true, data: { grouped, teams, teamAvailability } });

    } catch (err) {
        console.error('❌ GET GROUPED ERROR:', err);
        res.status(500).json({ success: false, message: 'Server error loading grouped items' });
    }
});

/* -------------------------------------------------------------
   2) CREATE INSTALLATION ORDER + ASSIGN ITEMS
-------------------------------------------------------------*/
router.post('/create', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { instReqMasterId, team_id, scheduled_date, note, items, empNo } = req.body;
        // Derive from the authenticated session rather than trusting a
        // client-supplied value — the frontend never actually sent this
        // (always null), so no assignment ever recorded who made it.
        const assignedBy = req.user?.userId ?? null;

        if (!instReqMasterId || !Array.isArray(items) || !items.length) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Must provide instReqMasterId and items' });
        }
        let leaderEmpNo = null;
        if (team_id) {
            const leaderRes = await sequelize2.query(
                `SELECT leader_emp_no FROM IIT_Petra.instTeams WHERE id = :teamId LIMIT 1`,
                { replacements: { teamId: team_id }, type: QueryTypes.SELECT, transaction: trx }
            );
            leaderEmpNo = leaderRes[0]?.leader_emp_no || null;
        }
        // Determine next order number — scoped per project, not globally,
        // so each project's installation orders count 1, 2, 3... on their
        // own instead of sharing one running number across every project.
        const maxQ = await sequelize2.query(`
            SELECT COALESCE(MAX(o.order_number), 0) AS maxOrder
            FROM IIT_Petra.instOrders o
            JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = o.instReqMasterId
            WHERE m.projectId = (
                SELECT projectId FROM IIT_Petra.instReqMaster WHERE instReqMasterId = :instReqMasterId
            )
        `, { replacements: { instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });
        const nextOrderNumber = (maxQ[0].maxOrder || 0) + 1;

        await sequelize2.query(`
    INSERT INTO IIT_Petra.instOrders
    (instReqMasterId, team_id, assignedEmpNo, order_number, status, assigned_date, scheduled_date, note, created_at, updated_at)
    VALUES (:masterId, :team, :empNo, :ord, 'assigned', NOW(), :sched, :note, NOW(), NOW())
`, {
            replacements: {
                masterId: instReqMasterId,
                team: team_id || null,
                empNo: leaderEmpNo,
                ord: nextOrderNumber,
                sched: scheduled_date || null,
                note: note || null
            },
            transaction: trx
        });

        const orderHeader = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
        const instOrderId = orderHeader[0].id;

        const skippedAlreadyAssigned = [];
        let processedCount = 0;
        for (const instReqDetId of items) {
            // Get detail info
            const detQ = await sequelize2.query(`
                SELECT d.rowId, d.assignedTeamId, d.instReqMasterId, m.unitIdContract AS unitNo, s.descAr AS itemName, m.height, m.width, o.orderNumber, m.orderId, m.unitShapeId
                FROM IIT_Petra.instReqDet d
                LEFT JOIN IIT_Petra.masterControl m ON m.rowId = d.rowId
                LEFT JOIN IIT_Petra.unitShapes s ON m.unitShapeId = s.unitShapeId
                LEFT JOIN IIT_Petra.orders o ON m.orderId = o.orderId
                WHERE d.instReqDetId = :id LIMIT 1
            `, { replacements: { id: instReqDetId }, type: QueryTypes.SELECT, transaction: trx });

            const det = detQ[0];
            if (!det) continue;
            // Guard against attaching a detail row from a different request
            // (stale frontend state, bad cache, or a direct API call) — never
            // checked before, so items could be silently pulled cross-project.
            if (Number(det.instReqMasterId) !== Number(instReqMasterId)) continue;
            // Already assigned to a team (this or another) — skip rather than
            // creating a second, invisible instOrderItems/instOrderSteps set
            // for the same request line item. Previously nothing checked
            // this, so two managers (or a double-submit) assigning the same
            // item to different teams both silently succeeded.
            if (det.assignedTeamId) {
                skippedAlreadyAssigned.push(instReqDetId);
                continue;
            }

            processedCount++;
            // Insert instOrderItems
            await sequelize2.query(`
                INSERT INTO IIT_Petra.instOrderItems
                (instOrderId, instReqDetId, rowId, itemName, unitNo, height, width, orderId, orderNumber, status, created_at)
                VALUES (:ordId, :detId, :rowId, :itemName, :unitNo, :h, :w, :orderId, :orderNum, 'assigned', NOW())
            `, {
                replacements: {
                    ordId: instOrderId,
                    detId: instReqDetId,
                    rowId: det.rowId,
                    itemName: det.itemName,
                    unitNo: det.unitNo,
                    h: det.height,
                    w: det.width,
                    orderId: det.orderId,
                    orderNum: det.orderNumber
                },
                transaction: trx
            });

            const itemRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            const instOrderItemId = itemRes[0].id;

            // Insert instOrderDetails
            await sequelize2.query(`
                INSERT INTO IIT_Petra.instOrderDetails
                (instOrderId, masterRowId, unitCount, width, height, glassType, unitShapeId)
                VALUES (:ordId, :rowId, 1, :w, :h, NULL, :u)
            `, { replacements: { ordId: instOrderId, rowId: det.rowId, w: det.width, h: det.height, u: det.unitShapeId }, transaction: trx });

            const detailRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            const instOrderDetailId = detailRes[0].id;

            // 1️⃣ Insert assignment if team is provided
            // 1️⃣ Get team leader empNo if team_id is provided


            // 2️⃣ Insert assignment using leaderEmpNo
            if (team_id) {
                await sequelize2.query(`
                    INSERT INTO IIT_Petra.instReqAssignments
                    (instReqDetId, assignedEmpNo, teamId, assignedBy, assignedAt, progressStatus, progressPercent, instOrderId, instOrderDetailId)
                    VALUES (:detId, :empNo, :team, :by, NOW(), 'Pending', 0, :ordId, :ordDetailId)
                    ON DUPLICATE KEY UPDATE instOrderId = :ordId, instOrderDetailId = :ordDetailId
                `, {
                    replacements: {
                        detId: instReqDetId,
                        empNo: leaderEmpNo, // use team leader here
                        team: team_id,
                        by: assignedBy || null,
                        ordId: instOrderId,
                        ordDetailId: instOrderDetailId
                    },
                    transaction: trx
                });

                await sequelize2.query(`
                    UPDATE IIT_Petra.instReqDet SET assignedTeamId = :team WHERE instReqDetId = :id
                `, { replacements: { team: team_id, id: instReqDetId }, transaction: trx });
            }


            // Insert instOrderSteps from instSteps
            const steps = await sequelize2.query(`
                SELECT instStepId, stepNumber, standardTime
                FROM IIT_Petra.instSteps
                WHERE unitTypeId = :shapeId
                ORDER BY instStepId ASC
            `, { replacements: { shapeId: det.unitShapeId }, type: QueryTypes.SELECT, transaction: trx });

            for (const step of steps) {
                await sequelize2.query(`
                    INSERT INTO IIT_Petra.instOrderSteps
                    (instOrderItemId, instStepId, status, stepOrder, createdAt, updatedAt)
                    VALUES (:itemId, :stepId, 'Pending', :order, NOW(), NOW())
                `, {
                    replacements: { itemId: instOrderItemId, stepId: step.instStepId, order: step.stepNumber },
                    transaction: trx
                });
            }
        }

        // If nothing in this batch actually got inserted (already assigned
        // elsewhere, not found, or didn't belong to this request), the order
        // header got created above but never received any items — remove
        // the empty shell rather than leaving a dangling order/number.
        if (processedCount === 0) {
            await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: instOrderId }, transaction: trx });
            await trx.commit();
            return res.json({
                success: true,
                message: 'No items in this batch could be assigned',
                data: { instOrderId: null, order_number: null, skippedAlreadyAssigned },
            });
        }

        // Update master request status if all items assigned
        const totalItems = await sequelize2.query(
            `SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`,
            { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx }
        );

        const assignedItems = await sequelize2.query(`
            SELECT COUNT(*) AS assigned
            FROM IIT_Petra.instReqAssignments a
            JOIN IIT_Petra.instReqDet d ON d.instReqDetId = a.instReqDetId
            WHERE d.instReqMasterId = :id
        `, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });

        if (Number(assignedItems[0].assigned) === Number(totalItems[0].total)) {
            await sequelize2.query(`
                UPDATE IIT_Petra.instReqMaster SET reqStatusId = 4  WHERE instReqMasterId = :id
            `, { replacements: { id: instReqMasterId, team: team_id }, transaction: trx });
        }

        await trx.commit();
        notifyOrderUpdate();
        res.json({
            success: true,
            message: 'Installation order created',
            data: { instOrderId, order_number: nextOrderNumber, skippedAlreadyAssigned },
        });

    } catch (err) {
        await trx.rollback();
        console.error('❌ CREATE ORDER ERROR:', err);
        res.status(500).json({ success: false, message: 'Server error creating installation order' });
    }
});


/* -------------------------------------------------------------
   3) UNASSIGN ITEM
-------------------------------------------------------------*/
router.delete('/unassign/:instOrderItemId', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { instOrderItemId } = req.params;

        const rows = await sequelize2.query(`
            SELECT i.id AS instOrderItemId, i.instOrderId, i.instReqDetId, a.id AS assignmentId, d.instReqMasterId
            FROM IIT_Petra.instOrderItems i
            LEFT JOIN IIT_Petra.instReqAssignments a ON a.instReqDetId = i.instReqDetId
            LEFT JOIN IIT_Petra.instReqDet d ON d.instReqDetId = i.instReqDetId
            WHERE i.id = :id LIMIT 1
        `, { replacements: { id: instOrderItemId }, type: QueryTypes.SELECT, transaction: trx });

        if (!rows.length) {
            await trx.rollback();
            return res.status(404).json({ success: false, message: 'Item not found' });
        }

        const { instOrderId, instReqDetId, assignmentId, instReqMasterId } = rows[0];

        if (!assignmentId) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'No assignment found for this item' });
        }

        await sequelize2.query(`DELETE FROM IIT_Petra.instReqAssignments WHERE id = :id`, { replacements: { id: assignmentId }, transaction: trx });
        await sequelize2.query(`DELETE FROM IIT_Petra.instOrderItems WHERE id = :id`, { replacements: { id: instOrderItemId }, transaction: trx });
        await sequelize2.query(`UPDATE IIT_Petra.instReqDet SET assignedTeamId = NULL WHERE instReqDetId = :id`, { replacements: { id: instReqDetId }, transaction: trx });

        const remain = await sequelize2.query(`SELECT COUNT(*) AS cnt FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: instOrderId }, type: QueryTypes.SELECT, transaction: trx });
        if (Number(remain[0].cnt) === 0) await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: instOrderId }, transaction: trx });

        const totalItems = await sequelize2.query(`SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });
        const assignedItems = await sequelize2.query(`SELECT COUNT(*) AS assigned FROM IIT_Petra.instReqAssignments a JOIN IIT_Petra.instReqDet d ON d.instReqDetId = a.instReqDetId WHERE d.instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });

        if (Number(assignedItems[0].assigned) < Number(totalItems[0].total)) {
            await sequelize2.query(`UPDATE IIT_Petra.instReqMaster SET reqStatusId = 1 WHERE instReqMasterId = :id`, { replacements: { id: instReqMasterId }, transaction: trx });
        }

        await trx.commit();
        notifyOrderUpdate();
        res.json({ success: true, message: 'Item unassigned successfully' });
    } catch (err) {
        await trx.rollback();
        console.error('❌ UNASSIGN ITEM ERROR:', err);
        res.status(500).json({ success: false, message: 'Error unassigning item' });
    }
});

/* -------------------------------------------------------------
   4) DELETE ORDER (FULL)
-------------------------------------------------------------*/
router.delete('/:orderId', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { orderId } = req.params;

        const items = await sequelize2.query(`SELECT instReqDetId FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: orderId }, type: QueryTypes.SELECT, transaction: trx });
        const detIds = items.map(i => i.instReqDetId).filter(Boolean);

        await sequelize2.query(`DELETE FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: orderId }, transaction: trx });
        await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: orderId }, transaction: trx });

        if (detIds.length) await sequelize2.query(`DELETE FROM IIT_Petra.instReqAssignments WHERE instReqDetId IN (:ids)`, { replacements: { ids: detIds }, transaction: trx });

        await trx.commit();
        notifyOrderUpdate();
        res.json({ success: true, message: 'Order deleted successfully' });
    } catch (err) {
        await trx.rollback();
        console.error('❌ DELETE ORDER ERROR:', err);
        res.status(500).json({ success: false, message: 'Error deleting order' });
    }
});

/* -------------------------------------------------------------
   5) GET ALL CREATED & ASSIGNED ORDERS (legacy)
-------------------------------------------------------------*/
router.get('/all-assigned', async (req, res) => {
    try {
        const orders = await sequelize2.query(`
            SELECT o.id AS instOrderId, o.order_number, o.instReqMasterId, o.team_id, o.scheduled_date, o.note,
                   i.id AS instOrderItemId, i.instReqDetId, i.itemName, i.unitNo, i.height, i.width, i.status,
                   a.id AS assignmentId, a.teamId, a.progressStatus, a.progressPercent
            FROM IIT_Petra.instOrders o
            JOIN IIT_Petra.instOrderItems i ON i.instOrderId = o.id
            LEFT JOIN IIT_Petra.instReqAssignments a ON a.instReqDetId = i.instReqDetId AND a.instOrderId = o.id
            ORDER BY o.order_number DESC, i.id ASC
        `, { type: QueryTypes.SELECT });

        // Group by the real unique order id, not order_number — order
        // numbers are now scoped per project, so two different projects can
        // legitimately share the same order_number and would otherwise get
        // merged together here.
        const grouped = {};
        orders.forEach(row => {
            if (!grouped[row.instOrderId]) grouped[row.instOrderId] = { header: row, items: [] };
            grouped[row.instOrderId].items.push({
                instOrderItemId: row.instOrderItemId,
                instReqDetId: row.instReqDetId,
                itemName: row.itemName,
                unitNo: row.unitNo,
                height: row.height,
                width: row.width,
                assigned: !!row.assignmentId,
                assignment: row.assignmentId
                    ? {
                        id: row.assignmentId,
                        teamId: row.teamId,
                        progressStatus: row.progressStatus,
                        progressPercent: row.progressPercent
                    }
                    : null
            });
        });

        const teams = await sequelize2.query(`SELECT id, name FROM IIT_Petra.instTeams ORDER BY id DESC`, { type: QueryTypes.SELECT });

        res.json({ success: true, data: { grouped, teams } });
    } catch (err) {
        console.error('❌ FETCH ALL ASSIGNED ORDERS ERROR:', err);
        res.status(500).json({ success: false, message: 'Server error fetching assigned orders' });
    }
});

/* -------------------------------------------------------------
   6) GET ALL ORDERS WITH ITEMS AND ASSIGNMENTS (MASTER)
-------------------------------------------------------------*/
router.get('/master', async (req, res) => {
    try {
        // Fetch all orders with their items and assignment + section name (if available)
        const items = await sequelize2.query(`
            SELECT 
                io.id AS instOrderId,
                io.order_number,
                io.instReqMasterId,
                io.team_id,
                io.scheduled_date,
                io.note,
                iod.id AS instOrderItemId,
                iod.instReqDetId,
                iod.rowId,
                iod.itemName,
                iod.unitNo,
                iod.height,
                iod.width,
                iod.status AS itemStatus,
                ira.id AS assignmentId,
                ira.teamId AS assignmentTeamId,
                ira.progressStatus,
                ira.progressPercent,
                COALESCE(p.profileSectionName, '') AS sectionName
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqAssignments ira ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.profileSection p ON m.profileSectionId = p.profileSectionId
            LEFT JOIN IIT_Petra.unitShapes s ON m.unitShapeId = s.unitShapeId
            ORDER BY io.order_number DESC, iod.id ASC
        `, { type: QueryTypes.SELECT });

        // Group by the real unique order id, not order_number — order
        // numbers are now scoped per project, so two different projects can
        // legitimately share the same order_number and would otherwise get
        // merged together here.
        const grouped = {};
        items.forEach(row => {
            if (!grouped[row.instOrderId]) {
                grouped[row.instOrderId] = {
                    header: {
                        instOrderId: row.instOrderId,
                        order_number: row.order_number,
                        instReqMasterId: row.instReqMasterId,
                        team_id: row.team_id,
                        scheduled_date: row.scheduled_date,
                        note: row.note
                    },
                    sections: {} // sections -> arrays
                };
            }

            const section = row.sectionName || 'Uncategorized';
            if (!grouped[row.instOrderId].sections[section]) grouped[row.instOrderId].sections[section] = [];

            grouped[row.instOrderId].sections[section].push({
                instOrderItemId: row.instOrderItemId,
                instReqDetId: row.instReqDetId,
                rowId: row.rowId,
                itemName: row.itemName,
                unitNo: row.unitNo,
                height: row.height,
                width: row.width,
                status: row.itemStatus,
                assigned: !!row.assignmentId,
                assignment: row.assignmentId ? {
                    id: row.assignmentId,
                    teamId: row.assignmentTeamId,
                    progressStatus: row.progressStatus,
                    progressPercent: row.progressPercent
                } : null
            });
        });

        // Fetch teams
        const teams = await sequelize2.query(`SELECT id, name FROM IIT_Petra.instTeams ORDER BY id DESC`, { type: QueryTypes.SELECT });

        res.json({ success: true, data: { grouped, teams } });

    } catch (err) {
        console.error('❌ FETCH MASTER ORDERS ERROR:', err);
        res.status(500).json({ success: false, message: 'Server error fetching master orders' });
    }
});

/* -------------------------------------------------------------
   7) ASSIGNED (API shaped for ManageOrders page) - FIXED
   Returns: { success: true, data: { orders: { [instOrderId]: { [sectionName]: GroupedItem[] } }, teams: [...] } }
-------------------------------------------------------------*/
router.get('/assigned', async (req, res) => {
    try {
        // 1️⃣ Fetch items
        const itemsRaw = await sequelize.query(`
            SELECT 
                io.id AS instOrderId,
                j.projectNo,
                j.projectName,
                io.order_number,
                iod.id AS instOrderItemId,
                iod.instReqDetId,
                iod.rowId,
                iod.itemName,
                m.unitIdContract,
                m.unitIdDetail as unitNo,
                iod.height,
                iod.width,
                ira.id AS assignmentId,
                ira.teamId AS assignmentTeamId,
                ira.progressStatus,
                COALESCE(p.profileSectionName, '') AS sectionName
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqAssignments ira ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.profileSection p ON m.profileSectionId = p.profileSectionId
            LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
            
            ORDER BY io.id DESC, iod.id ASC
        `, { type: QueryTypes.SELECT });

        // Normalize Arabic fields
        const items = itemsRaw.map(r => ({
            ...r,
            itemName: fixArabic(r.itemName),
            projectName: fixArabic(r.projectName),
            projectNo: r.projectNo
        }));

        const itemIds = items.map(i => i.instOrderItemId);

        // 2️⃣ Fetch steps
        let steps = [];
        if (itemIds.length > 0) {
            steps = await sequelize2.query(
                `SELECT 
                    s.id AS stepId,
                    s.instOrderItemId,
                    s.instStepId,
                    s.status,
                    i.stepName,
                    i.standardTime,
                    i.stepNumber AS stepOrder,
                    s.createdAt,
                    s.updatedAt
                FROM IIT_Petra.instOrderSteps s
                LEFT JOIN IIT_Petra.instSteps i ON s.instStepId = i.instStepId
                WHERE s.instOrderItemId IN (:ids)
                ORDER BY s.instOrderItemId ASC, stepOrder ASC`,
                { replacements: { ids: itemIds }, type: QueryTypes.SELECT }
            );
        }

        // 3️⃣ Fetch all updates for these steps
        let stepUpdates = [];
        if (steps.length > 0) {
            const stepIds = steps.map(s => s.stepId);
            stepUpdates = await sequelize2.query(
                `SELECT 
                    u.instOrderStepId,
                    u.status,
                    u.problem_note as note,
                    u.image_before,
                    u.image_after,
                    u.createdAt,
                    u.updatedAt
                FROM IIT_Petra.instOrderStepUpdates u
                WHERE u.instOrderStepId IN (:ids)
                ORDER BY u.instOrderStepId ASC, u.createdAt ASC`,
                { replacements: { ids: stepIds }, type: QueryTypes.SELECT }
            );
        }

        // 4️⃣ Build stepMap with photos history
        const stepMap = {};
        const lastPhotoMap = {}; // final lastPhoto per item

        steps.forEach(s => {
            stepMap[s.instOrderItemId] = stepMap[s.instOrderItemId] || [];

            const updates = stepUpdates
                .filter(u => u.instOrderStepId === s.stepId)
                .map(u => {
                    const url = u.image_after || u.image_before || null;

                    if (url) {
                        // Update last photo for item
                        lastPhotoMap[s.instOrderItemId] = url;
                    }

                    return {
                        url,
                        note: u.note || '',
                        type: u.status.toLowerCase(),
                        date: u.createdAt
                    };
                });

            stepMap[s.instOrderItemId].push({
                ...s,
                stepName: fixArabic(s.stepName),
                projectName: fixArabic(s.projectName),
                photos: updates
            });
        });

        // 5️⃣ Calculate progress + issue % (STANDARD TIME)
        const progressMap = {};
        const issueMap = {};

        Object.entries(stepMap).forEach(([itemId, steps]) => {
            const totalTime = steps.reduce(
                (sum, s) => sum + (Number(s.standardTime) || 0),
                0
            );

            const finishedTime = steps
                .filter(s =>
                    ['completed', 'done'].includes(
                        (s.status || '').toLowerCase()
                    )
                )
                .reduce(
                    (sum, s) => sum + (Number(s.standardTime) || 0),
                    0
                );

            const issueTime = steps
                .filter(s => (s.status || '').toLowerCase() === 'issue')
                .reduce(
                    (sum, s) => sum + (Number(s.standardTime) || 0),
                    0
                );

            progressMap[itemId] =
                totalTime > 0
                    ? Math.round((finishedTime / totalTime) * 100)
                    : 0;

            issueMap[itemId] =
                totalTime > 0
                    ? Math.round((issueTime / totalTime) * 100)
                    : 0;
        });



        // 6️⃣ Build grouped order structure
        const orders = {};

        items.forEach(row => {
            const orderId = row.instOrderId;
            const section = row.sectionName || "Uncategorized";

            if (!orders[orderId]) orders[orderId] = {};
            if (!orders[orderId][section]) orders[orderId][section] = [];

            orders[orderId][section].push({
                instOrderItemId: row.instOrderItemId,
                instReqDetId: row.instReqDetId,
                rowId: row.rowId,
                itemName: row.itemName,
                unitIdContract: row.unitIdContract,
                unitNo: row.unitNo,
                height: row.height,
                width: row.width,
                projectName: fixArabic(row.projectName),
                projectNo: row.projectNo,
                instOrderId: row.instOrderId,
                orderNumber: row.order_number,
                assigned: !!row.assignmentId,
                assignment: row.assignmentId
                    ? {
                        instOrderItemId: row.instOrderItemId,
                        instOrderId: row.instOrderId,
                        teamId: row.assignmentTeamId,
                        progressStatus: row.progressStatus,
                        progressPercent: progressMap[row.instOrderItemId] || 0,
                        issuePercent: issueMap[row.instOrderItemId] || 0
                    }
                    : null,

                steps: stepMap[row.instOrderItemId] || [],
                lastPhoto: lastPhotoMap[row.instOrderItemId] || null
            });
        });

        // 7️⃣ Return teams
        const teams = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams ORDER BY id DESC`,
            { type: QueryTypes.SELECT }
        );

        // 8️⃣ Fetch recent team checkpoints (used by Field News) - last 48 hours
        // UTC_TIMESTAMP(), not NOW() — checkpoints are now written with
        // UTC_TIMESTAMP() (see /follow-up/team/checkpoint), so the cutoff
        // here has to use the same reference or the window silently
        // shrinks: NOW() is 3 hours ahead of UTC_TIMESTAMP() on this
        // server, so DATE_SUB(NOW(), 48h) was effectively a 45-hour cutoff
        // against UTC-stored createdAt values.
        const rawCheckpoints = await sequelize3.query(
            `SELECT c.id,
                    c.team_id AS teamId,
                    c.checkpoint_type AS checkpointType,
                    c.notes AS note,
                    j.projectNo AS projectNo,
                    j.projectName AS projectName,
                    c.latitude,
                    c.longitude,
                    c.createdAt
             FROM IIT_Petra.instTeamCheckpoints c
             LEFT JOIN IIT_Petra.instOrders iod ON iod.Id = c.order_id
             LEFT JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = iod.instReqMasterId
             LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
             WHERE c.createdAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
             ORDER BY c.createdAt DESC`,
            { type: QueryTypes.SELECT }
        );

        const checkpoints = (Array.isArray(rawCheckpoints) ? rawCheckpoints : []).map((c) => ({
            ...c,
            projectName: fixArabic(c.projectName),
        }));

        // 9️⃣ Fetch recent step-status-update history (last 48 hours) so
        // Field News's "update"/"completed" entries survive a page
        // refresh — they used to exist only as in-memory deltas detected
        // live by detectChanges() on the frontend, so refreshing (or a
        // dashboard that wasn't open at the time) lost them for good,
        // unlike checkpoints above which are always re-queried fresh.
        // Deliberately only fetches the raw facts (which step, what
        // status, when) — item/project/team display labels are resolved
        // by the frontend from `orders`/`teams` above (the same data
        // detectChanges() already uses for live-detected entries), since
        // this item's masterControl-sourced itemName/projectName hit a
        // separate, pre-existing mojibake issue that a naive fixArabic()
        // pass here corrupts further rather than fixes.
        const rawStepUpdates = await sequelize2.query(
            `SELECT u.id,
                    u.instOrderStepId AS stepId,
                    u.status,
                    u.problem_note AS note,
                    u.image_after,
                    u.image_before,
                    u.createdAt,
                    s.instOrderItemId,
                    stepDef.stepName
             FROM IIT_Petra.instOrderStepUpdates u
             JOIN IIT_Petra.instOrderSteps s ON s.id = u.instOrderStepId
             JOIN IIT_Petra.instSteps stepDef ON stepDef.instStepId = s.instStepId
             WHERE u.createdAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
             ORDER BY u.createdAt DESC`,
            { type: QueryTypes.SELECT }
        );

        const recentStepUpdates = (Array.isArray(rawStepUpdates) ? rawStepUpdates : []).map((u) => ({
            ...u,
            stepName: fixArabic(u.stepName),
        }));

        res.json({ success: true, data: { orders, teams, checkpoints, recentStepUpdates } });

    } catch (err) {
        console.error("❌ FETCH ASSIGNED ORDERS ERROR:", err);
        res.status(500).json({ success: false, message: "Error fetching assigned orders" });
    }
});

/* -------------------------------------------------------------
   INSTALLATION ORDERS STATUS REPORT (Option B)
--------------------------------------------------------------*/
router.get('/status-report', async (req, res) => {
    try {
        const rows = await sequelize2.query(
            `
            SELECT s.instReqStatusName AS status, COUNT(*) AS count
            FROM instReqMaster m
            JOIN instReqStatus s ON s.instReqStatusId = m.reqStatusId
            GROUP BY s.instReqStatusName
            ORDER BY s.instReqStatusName
            `,
            { type: QueryTypes.SELECT }
        );

        return res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error loading installation status report:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to load installation status report'
        });
    }
});

/* -------------------------------------------------------------
   AT-RISK PROJECTS
   Flags orders whose remaining standard-time (for incomplete steps)
   won't realistically fit before their scheduled_date, assuming an
   8-hour working day.
--------------------------------------------------------------*/
const WORK_HOURS_PER_DAY = 8;

router.get('/at-risk', async (req, res) => {
    try {
        const orders = await sequelize.query(
            `
            SELECT DISTINCT
                io.id AS instOrderId,
                io.order_number,
                io.scheduled_date,
                j.projectNo,
                j.projectName
            FROM IIT_Petra.instOrders io
            LEFT JOIN IIT_Petra.instOrderItems iod ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.project j ON m.projectId = j.projectId
            WHERE io.scheduled_date IS NOT NULL
            `,
            { type: QueryTypes.SELECT }
        );

        const remaining = await sequelize2.query(
            `
            SELECT iod.instOrderId, SUM(st.standardTime) AS remainingMinutes
            FROM IIT_Petra.instOrderSteps s
            JOIN IIT_Petra.instOrderItems iod ON iod.id = s.instOrderItemId
            LEFT JOIN IIT_Petra.instSteps st ON st.instStepId = s.instStepId
            WHERE LOWER(s.status) NOT IN ('completed', 'done')
            GROUP BY iod.instOrderId
            `,
            { type: QueryTypes.SELECT }
        );
        const remainingByOrder = new Map(remaining.map(r => [r.instOrderId, Number(r.remainingMinutes) || 0]));

        const now = new Date();
        const data = orders
            .map(o => {
                const remainingMinutes = remainingByOrder.get(o.instOrderId) || 0;
                const scheduledDate = new Date(o.scheduled_date);
                const daysRemaining = Math.ceil((scheduledDate - now) / (1000 * 60 * 60 * 24));
                const daysNeeded = Math.ceil(remainingMinutes / 60 / WORK_HOURS_PER_DAY);
                return {
                    orderId: o.instOrderId,
                    orderNumber: o.order_number,
                    projectName: fixArabic(o.projectName),
                    projectNo: o.projectNo,
                    scheduledDate: o.scheduled_date,
                    remainingMinutes,
                    daysRemaining,
                    daysNeeded,
                    atRisk: remainingMinutes > 0 && daysNeeded > daysRemaining,
                    overdue: remainingMinutes > 0 && daysRemaining < 0,
                };
            })
            // Only orders with remaining work are meaningful here — fully
            // completed orders can't be "at risk."
            .filter(o => o.remainingMinutes > 0)
            .sort((a, b) => a.daysRemaining - b.daysRemaining);

        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ AT-RISK REPORT ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to build at-risk report' });
    }
});


// routes/instOrders.js
let clients = [];

// --- PATCH START: Always send JSON with event property for SSE ---

router.get('/stream', (req, res) => {
    console.info('[SSE] New client connected');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Always send a JSON object for the initial connection
    res.write(`data: {"event":"connected"}\n\n`);

    const clientId = Date.now();
    clients.push({ id: clientId, res });

    // Without a periodic keep-alive, idle connections through a reverse
    // proxy / dev tunnel (e.g. the devtunnel used for mobile testing) can
    // get silently dropped after their idle timeout — the browser's
    // EventSource doesn't always notice right away, so field news /
    // refresh events sent during that dead window are just lost with no
    // visible error. A comment line every 20s keeps the connection active
    // without being a real event the client needs to parse.
    const heartbeat = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch {
            clearInterval(heartbeat);
        }
    }, 20000);

    req.on('close', () => {
        console.info('[SSE] Client disconnected:', clientId);
        clearInterval(heartbeat);
        clients = clients.filter(c => c.id !== clientId);
    });
});

// --- PATCH: Always ensure event property in notifyOrderUpdate ---
export function notifyOrderUpdate(payload = { event: 'update' }) {
    if (!payload.event) payload.event = 'update'; // Ensure event property
    console.log('[SSE] Broadcasting to', clients.length, 'clients:', payload);
    clients.forEach(c => {
        try {
            c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
            console.log('[SSE] Sent to client', c.id);
        } catch (e) {
            console.error('[SSE] Error sending to client', c.id, e);
        }
    });
}

export default router;
