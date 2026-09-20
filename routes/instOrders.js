import express from 'express';
import { sequelize, sequelize2, sequelize3, sequelize2PetraErp } from '../config/db.js';
import { QueryTypes, Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, blockWritesForReadOnlyRoles } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { InstOrderComponent } from '../models/InstOrderComponent.js';
import { Project } from '../models/Project.js';
import { InstTeamVacation } from '../models/InstTeamVacation.js';
import { InstOrderScheduleDay } from '../models/InstOrderScheduleDay.js';
import { ProjectMapCache } from '../models/ProjectMapCache.js';
import { User } from '../models/User.js';
import { recordComponentAction, getUnitCompletionStats, markUnitComplete } from '../services/instOrderComponents.js';
import { mapWithConcurrencyLimit } from '../utils/concurrency.js';
import { isShortMapLink, extractCoords, extractPlaceName, resolveShortMapLink } from '../services/resolveMapLink.js';
import { reverseGeocodeArea } from '../services/reverseGeocode.js';
import { toDateOnlyString } from '../utils/dateOnly.js';

const router = express.Router();
// Every route in this file operates on order/project data and previously had
// no authentication at all — require a valid token for all of them. All
// endpoints here are only ever called from the manager-facing web dashboard
// (ManageOrdersPage/reports.tsx via useOrders.ts), which the frontend
// already gates to manager/admin (see router.tsx) — this mirrors that same
// restriction on the backend so it can't be bypassed by calling the API directly.
router.use(authenticateToken);
router.use(requirePermission(PERMISSIONS.INSTALLATION_MANAGE_ORDERS));
router.use(blockWritesForReadOnlyRoles);

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

// Best-effort record that `teamId` was scheduled to `instOrderId` on
// `date` -- the day-by-day roster history instOrders.team_id/scheduled_date
// alone can't provide, since those are single mutable fields overwritten on
// every reassignment/day rollover (see models/InstOrderScheduleDay.js).
// Lives on a separate MySQL connection (sequelizeUtf8) from this file's own
// sequelize2 transactions, so it can't be part of the same transaction --
// always called AFTER the real order write has already committed, and
// never allowed to fail a request whose actual order write already
// succeeded.
export async function recordScheduleDay(instOrderId, teamId, date, userId) {
    if (!instOrderId || !teamId || !date) return;
    try {
        await InstOrderScheduleDay.upsert({
            instOrderId,
            teamId,
            date: toDateOnlyString(date),
            createdByUserId: userId ?? null,
        });
    } catch (err) {
        console.error('❌ RECORD SCHEDULE DAY ERROR:', err);
    }
}

/* -------------------------------------------------------------
   2) CREATE INSTALLATION ORDER + ASSIGN ITEMS
-------------------------------------------------------------*/
router.post('/create', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        let { instReqMasterId, team_id, scheduled_date, note, items, empNo, visitOnly, projectId } = req.body;
        // Derive from the authenticated session rather than trusting a
        // client-supplied value — the frontend never actually sent this
        // (always null), so no assignment ever recorded who made it.
        const assignedBy = req.user?.userId ?? null;

        // Special-case escape hatch: schedule a team to ANY project in the
        // system (via projectId), not just ones that already have a formal
        // installation request (instReqMaster) submitted through Petra ERP
        // -- for one-off/ad-hoc site work outside the normal request
        // pipeline. Synthesizes a minimal instReqMaster row scoped to this
        // project so every other route that joins through
        // instOrders -> instReqMaster -> project keeps working unchanged.
        // There's no real request line items for a project with no
        // request, so this path is always visit-only/zero-item.
        if (!instReqMasterId && projectId) {
            // Project lives on a separate connection (sequelize2PetraErp,
            // for correct Arabic decoding) from trx (sequelize2) -- plain
            // read, not part of this transaction.
            const projectRow = await Project.findByPk(projectId, { attributes: ['projectId'] });
            if (!projectRow) {
                await trx.rollback();
                return res.status(404).json({ success: false, message: 'Project not found' });
            }
            const reqNoRes = await sequelize2.query(
                `SELECT COALESCE(MAX(CAST(reqNo AS UNSIGNED)), 0) + 1 AS nextReqNo FROM IIT_Petra.instReqMaster WHERE projectId = :projectId`,
                { replacements: { projectId }, type: QueryTypes.SELECT, transaction: trx }
            );
            await sequelize2.query(`
                INSERT INTO IIT_Petra.instReqMaster (projectId, reqNo, reqStatusId, notes, assignedTeamId)
                VALUES (:projectId, :reqNo, 4, :notes, :team)
            `, {
                replacements: {
                    projectId,
                    reqNo: String(reqNoRes[0].nextReqNo),
                    notes: note || '',
                    team: team_id || 0,
                },
                transaction: trx,
            });
            const masterRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            instReqMasterId = masterRes[0].id;
            visitOnly = true;
            items = [];
        }

        if (!instReqMasterId || !Array.isArray(items)) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Must provide instReqMasterId and items' });
        }
        // visitOnly is the explicit opt-in for a team being scheduled to
        // check a site rather than install anything -- an empty `items`
        // array without it stays an error, same as before, so a caller
        // that meant to send real items but sent none by mistake still
        // gets a 400 instead of a silent no-op order.
        if (!items.length && !visitOnly) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Must provide items, or set visitOnly to schedule a visit with no items' });
        }
        // Dedupe up front -- the batched insert below does a single
        // up-front SELECT of every detail row's assignedTeamId before any
        // writes happen, so (unlike the old per-item sequential loop,
        // where a repeat id's re-SELECT would already see the first
        // occurrence's UPDATE) a repeated id in `items` would otherwise
        // pass the "not yet assigned" check twice and create duplicate
        // instOrderItems/instOrderDetails/instOrderSteps rows.
        const seenItemIds = new Set();
        const dedupedItems = items.filter((it) => {
            const key = String(it);
            if (seenItemIds.has(key)) return false;
            seenItemIds.add(key);
            return true;
        });
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

        // Visit-only: the order header above (team + scheduled_date + note)
        // is the whole point -- stop here rather than falling into the
        // item-processing block below, whose own "nothing got inserted"
        // cleanup further down would otherwise delete this order as an
        // empty shell (it's built to catch *unintended* zero-item results,
        // not this intentional one).
        if (visitOnly && !dedupedItems.length) {
            await trx.commit();
            await recordScheduleDay(instOrderId, team_id, scheduled_date, assignedBy);
            notifyOrderUpdate();
            return res.json({
                success: true,
                message: 'Visit scheduled',
                data: { instOrderId, order_number: nextOrderNumber, skippedAlreadyAssigned: [] },
            });
        }

        // Batch-fetch every detail row in one query instead of one round
        // trip per item — this whole block used to issue ~6 queries per
        // item plus one per step (300+ round trips for a 30-item/5-step
        // batch, all serialized inside one open transaction holding locks).
        const detRows = dedupedItems.length
            ? await sequelize2.query(`
                SELECT d.instReqDetId, d.rowId, d.assignedTeamId, d.instReqMasterId, m.unitIdContract AS unitNo, s.descAr AS itemName, m.height, m.width, o.orderNumber, m.orderId, m.unitShapeId
                FROM IIT_Petra.instReqDet d
                LEFT JOIN IIT_Petra.masterControl m ON m.rowId = d.rowId
                LEFT JOIN IIT_Petra.unitShapes s ON m.unitShapeId = s.unitShapeId
                LEFT JOIN IIT_Petra.orders o ON m.orderId = o.orderId
                WHERE d.instReqDetId IN (:ids)
            `, { replacements: { ids: dedupedItems }, type: QueryTypes.SELECT, transaction: trx })
            : [];
        const detByReqId = new Map(detRows.map((d) => [String(d.instReqDetId), d]));

        // A different team assigning an item that's already assigned is now
        // allowed on purpose -- multiple teams can share the same items
        // (instReqAssignments has no uniqueness constraint beyond its own
        // id, by design). Only a repeat assignment of the SAME item to the
        // SAME team is still a no-op skip, so a double-submit doesn't create
        // a duplicate instOrderItems/instReqAssignments row.
        const existingForTeam = (dedupedItems.length && team_id)
            ? await sequelize2.query(`
                SELECT DISTINCT instReqDetId FROM IIT_Petra.instReqAssignments
                WHERE instReqDetId IN (:ids) AND teamId = :team
            `, { replacements: { ids: dedupedItems, team: team_id }, type: QueryTypes.SELECT, transaction: trx })
            : [];
        const alreadyAssignedToThisTeam = new Set(existingForTeam.map((r) => String(r.instReqDetId)));

        const skippedAlreadyAssigned = [];
        const validDets = [];
        for (const instReqDetId of dedupedItems) {
            const det = detByReqId.get(String(instReqDetId));
            if (!det) continue;
            // Guard against attaching a detail row from a different request
            // (stale frontend state, bad cache, or a direct API call) — never
            // checked before, so items could be silently pulled cross-project.
            if (Number(det.instReqMasterId) !== Number(instReqMasterId)) continue;
            if (alreadyAssignedToThisTeam.has(String(instReqDetId))) {
                skippedAlreadyAssigned.push(instReqDetId);
                continue;
            }
            validDets.push({ instReqDetId, ...det });
        }

        let processedCount = validDets.length;

        if (processedCount > 0) {
            // Bulk-insert instOrderItems in one multi-row statement. MySQL
            // guarantees LAST_INSERT_ID() returns the id of the FIRST row a
            // multi-row INSERT generated, and that a single INSERT
            // statement's own generated ids are consecutive — safe to
            // derive every row's id as firstId + index without a query per
            // row (see MySQL docs on LAST_INSERT_ID() with multi-row
            // inserts).
            const itemsReplacements = { ordId: instOrderId };
            const itemsValues = validDets.map((d, i) => {
                itemsReplacements[`detId${i}`] = d.instReqDetId;
                itemsReplacements[`rowId${i}`] = d.rowId;
                itemsReplacements[`itemName${i}`] = d.itemName;
                itemsReplacements[`unitNo${i}`] = d.unitNo;
                itemsReplacements[`h${i}`] = d.height;
                itemsReplacements[`w${i}`] = d.width;
                itemsReplacements[`orderId${i}`] = d.orderId;
                itemsReplacements[`orderNum${i}`] = d.orderNumber;
                return `(:ordId, :detId${i}, :rowId${i}, :itemName${i}, :unitNo${i}, :h${i}, :w${i}, :orderId${i}, :orderNum${i}, 'assigned', NOW())`;
            }).join(', ');
            await sequelize2.query(`
                INSERT INTO IIT_Petra.instOrderItems
                (instOrderId, instReqDetId, rowId, itemName, unitNo, height, width, orderId, orderNumber, status, created_at)
                VALUES ${itemsValues}
            `, { replacements: itemsReplacements, transaction: trx });
            const itemRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            const firstItemId = Number(itemRes[0].id);
            validDets.forEach((d, i) => { d.instOrderItemId = firstItemId + i; });

            // Bulk-insert instOrderDetails the same way.
            const detailsReplacements = { ordId: instOrderId };
            const detailsValues = validDets.map((d, i) => {
                detailsReplacements[`rowId${i}`] = d.rowId;
                detailsReplacements[`w${i}`] = d.width;
                detailsReplacements[`h${i}`] = d.height;
                detailsReplacements[`u${i}`] = d.unitShapeId;
                return `(:ordId, :rowId${i}, 1, :w${i}, :h${i}, NULL, :u${i})`;
            }).join(', ');
            await sequelize2.query(`
                INSERT INTO IIT_Petra.instOrderDetails
                (instOrderId, masterRowId, unitCount, width, height, glassType, unitShapeId)
                VALUES ${detailsValues}
            `, { replacements: detailsReplacements, transaction: trx });
            const detailRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            const firstDetailId = Number(detailRes[0].id);
            validDets.forEach((d, i) => { d.instOrderDetailId = firstDetailId + i; });

            if (team_id) {
                const assignReplacements = { team: team_id, by: assignedBy || null, empNo: leaderEmpNo };
                const assignValues = validDets.map((d, i) => {
                    assignReplacements[`detId${i}`] = d.instReqDetId;
                    assignReplacements[`ordId${i}`] = instOrderId;
                    assignReplacements[`ordDetailId${i}`] = d.instOrderDetailId;
                    return `(:detId${i}, :empNo, :team, :by, NOW(), 'Pending', 0, :ordId${i}, :ordDetailId${i})`;
                }).join(', ');
                await sequelize2.query(`
                    INSERT INTO IIT_Petra.instReqAssignments
                    (instReqDetId, assignedEmpNo, teamId, assignedBy, assignedAt, progressStatus, progressPercent, instOrderId, instOrderDetailId)
                    VALUES ${assignValues}
                    ON DUPLICATE KEY UPDATE instOrderId = VALUES(instOrderId), instOrderDetailId = VALUES(instOrderDetailId)
                `, { replacements: assignReplacements, transaction: trx });

                // Only stamps the FIRST team onto instReqDet -- this column
                // can hold one value, but an item can now have several
                // instReqAssignments rows (multiple teams). It only still
                // matters as the "has anyone ever touched this item" gate
                // used by GET /requests-with-pending, so it's left alone
                // once set rather than overwritten by a second team.
                await sequelize2.query(`
                    UPDATE IIT_Petra.instReqDet SET assignedTeamId = :team WHERE instReqDetId IN (:ids) AND assignedTeamId IS NULL
                `, { replacements: { team: team_id, ids: validDets.map((d) => d.instReqDetId) }, transaction: trx });
            }

            // New orders no longer get a legacy instOrderSteps checklist --
            // component tracking (InstOrderComponent, scanned against real
            // Stock allocation) is the only progress model going forward.
            // instSteps/instOrderSteps stay in the schema and stay readable
            // for orders created before this cutover, but nothing writes new
            // rows into them any more.
        }

        // If nothing in this batch actually got inserted (already assigned
        // elsewhere, not found, or didn't belong to this request), the order
        // header got created above but never received any items — remove
        // the empty shell rather than leaving a dangling order/number.
        if (processedCount === 0) {
            await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: instOrderId }, transaction: trx });

            // Every item in this batch was already this SAME team's own --
            // confirmed live, this is exactly what happens when a project is
            // already fully assigned to a team and someone "adds" it again
            // for a different day, wanting to move that team's existing work
            // there (e.g. it slipped, or they're scheduling 2-3 days out).
            // Previously this returned a bare "nothing to assign" with no
            // actual effect, requiring a separate manual "Continue to next
            // day" on the right order; now it finds that team's own
            // existing order(s) for this same request and reschedules them
            // to scheduled_date directly, so "assign this team to this
            // project for day X" does the right thing regardless of whether
            // they're new to it or already own every item.
            let rescheduledOrderIds = [];
            if (team_id && scheduled_date && skippedAlreadyAssigned.length > 0) {
                const existingOrders = await sequelize2.query(`
                    SELECT DISTINCT io.instOrderId AS id
                    FROM IIT_Petra.instOrderItems io
                    WHERE io.instReqDetId IN (:ids)
                      AND io.instOrderId IN (
                          SELECT id FROM IIT_Petra.instOrders WHERE team_id = :team_id
                      )
                `, { replacements: { ids: skippedAlreadyAssigned, team_id }, type: QueryTypes.SELECT, transaction: trx });
                rescheduledOrderIds = existingOrders.map((o) => o.id);
                if (rescheduledOrderIds.length) {
                    await sequelize2.query(`
                        UPDATE IIT_Petra.instOrders SET scheduled_date = :scheduled_date, updated_at = NOW()
                        WHERE id IN (:ids)
                    `, { replacements: { scheduled_date, ids: rescheduledOrderIds }, transaction: trx });
                }
            }

            await trx.commit();
            for (const id of rescheduledOrderIds) {
                await recordScheduleDay(id, team_id, scheduled_date, assignedBy);
            }
            if (rescheduledOrderIds.length) notifyOrderUpdate();
            return res.json({
                success: true,
                message: rescheduledOrderIds.length
                    ? 'Rescheduled existing work to the new date'
                    : 'No items in this batch could be assigned',
                data: { instOrderId: null, order_number: null, skippedAlreadyAssigned, rescheduledOrderIds },
            });
        }

        // Update master request status if all items assigned
        const totalItems = await sequelize2.query(
            `SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`,
            { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx }
        );

        // DISTINCT instReqDetId -- an item can now have more than one
        // instReqAssignments row (multiple teams), a plain COUNT(*) would
        // over-count and this "fully assigned" check would never trip.
        const assignedItems = await sequelize2.query(`
            SELECT COUNT(DISTINCT a.instReqDetId) AS assigned
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
        await recordScheduleDay(instOrderId, team_id, scheduled_date, assignedBy);
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

        // Joined on instOrderId too, not just instReqDetId -- an item can
        // now have more than one instReqAssignments row (multiple teams),
        // so instReqDetId alone could match the wrong team's assignment row
        // under LIMIT 1. instOrderId narrows it to the specific order this
        // instOrderItemId actually belongs to.
        const rows = await sequelize2.query(`
            SELECT i.id AS instOrderItemId, i.instOrderId, i.instReqDetId, a.id AS assignmentId, d.instReqMasterId
            FROM IIT_Petra.instOrderItems i
            LEFT JOIN IIT_Petra.instReqAssignments a ON a.instReqDetId = i.instReqDetId AND a.instOrderId = i.instOrderId
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
        // Only clear the pending-gate flag if no other team still has this
        // item assigned via a different order (multi-team support).
        const stillAssigned = await sequelize2.query(`SELECT COUNT(*) AS cnt FROM IIT_Petra.instReqAssignments WHERE instReqDetId = :id`, { replacements: { id: instReqDetId }, type: QueryTypes.SELECT, transaction: trx });
        if (Number(stillAssigned[0].cnt) === 0) {
            await sequelize2.query(`UPDATE IIT_Petra.instReqDet SET assignedTeamId = NULL WHERE instReqDetId = :id`, { replacements: { id: instReqDetId }, transaction: trx });
        }

        const remain = await sequelize2.query(`SELECT COUNT(*) AS cnt FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: instOrderId }, type: QueryTypes.SELECT, transaction: trx });
        if (Number(remain[0].cnt) === 0) await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: instOrderId }, transaction: trx });

        const totalItems = await sequelize2.query(`SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });
        const assignedItems = await sequelize2.query(`SELECT COUNT(DISTINCT a.instReqDetId) AS assigned FROM IIT_Petra.instReqAssignments a JOIN IIT_Petra.instReqDet d ON d.instReqDetId = a.instReqDetId WHERE d.instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });

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
   SCHEDULE: daily team roster -- every team for one day, with
   whichever project(s) they're scheduled on that day (if any) and
   whether they're marked on vacation. Unlike GET /schedule (which
   lists orders and only shows teams that already have one), this
   always lists every team so a manager can see who has nothing
   scheduled yet, or who's on vacation, at a glance.

   Registered here, before the generic DELETE /:orderId below, on
   purpose -- Express matches routes in registration order, and
   /:orderId matches any single path segment including
   "team-vacation", so POST/DELETE /team-vacation would otherwise
   never be reached.
-------------------------------------------------------------*/
router.get('/team-roster', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({ success: false, message: 'date query param is required (YYYY-MM-DD)' });
        }

        // installation_supervisor only sees teams they supervise
        // (instTeams.supervisor_emp_no) -- this is the endpoint the
        // Schedule page (pages/schedule.tsx) actually calls for its team
        // roster; GET /schedule below is a separate, apparently-unused
        // endpoint that was scoped first by mistake (same supervisor_emp_no
        // gap, just not what's actually on screen).
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;

        // teams, orders, and vacations only depend on date/empNo, not on
        // each other -- fired together instead of one after another.
        // Every Quick Assign/Cancel/vacation toggle on the Schedule page
        // ends in a full refetch of this endpoint, so each sequential
        // round trip here was directly felt as UI lag on every single
        // add/remove action.
        const [teams, orders, vacations] = await Promise.all([
            sequelize2.query(
                `SELECT id, name FROM IIT_Petra.instTeams ${isScoped ? 'WHERE supervisor_emp_no = :empNo' : ''} ORDER BY name ASC`,
                { replacements: { empNo }, type: QueryTypes.SELECT }
            ),
            // Joined through InstOrderScheduleDays (this date's actual
            // day-by-day record, see models/InstOrderScheduleDay.js) rather
            // than instOrders.scheduled_date/team_id directly -- those two
            // fields only ever hold the LATEST assignment, so browsing to a
            // past date here used to silently show whatever the order's
            // schedule has since moved on to, not what was actually true
            // that day. sd.teamId (not o.team_id) is the team as of THIS
            // date.
            sequelize2.query(`
                SELECT
                    o.id AS instOrderId,
                    o.order_number,
                    sd.teamId AS team_id,
                    p.projectNo,
                    p.projectManagerId,
                    m.projectId,
                    (SELECT COUNT(*) FROM IIT_Petra.instOrderItems ii WHERE ii.instOrderId = o.id) AS itemCount
                FROM IIT_Petra.InstOrderScheduleDays sd
                JOIN IIT_Petra.instOrders o ON o.id = sd.instOrderId
                LEFT JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = o.instReqMasterId
                LEFT JOIN IIT_Petra.project p ON p.projectId = m.projectId
                WHERE sd.date = :date
                  ${isScoped ? 'AND sd.teamId IN (SELECT id FROM IIT_Petra.instTeams WHERE supervisor_emp_no = :empNo)' : ''}
            `, { replacements: { date, empNo }, type: QueryTypes.SELECT }),
            InstTeamVacation.findAll({ where: { vacationDate: date } }),
        ]);

        // Project managers live in IIT_Petra.user (see the comment further
        // down where this is consumed) and only depend on `orders`, not on
        // any of the projectInfo resolution below -- fired now and awaited
        // later, so it runs concurrently with that block instead of after it.
        const managerIds = [...new Set(orders.map(o => o.projectManagerId).filter(Boolean))];
        const managerNamesPromise = managerIds.length
            ? sequelize2.query(
                'SELECT userId, firstName, lastName, username FROM IIT_Petra.`user` WHERE userId IN (:ids)',
                { replacements: { ids: managerIds }, type: QueryTypes.SELECT }
            )
            : Promise.resolve([]);

        // projectName/address need the PetraErp-charset connection -- see
        // the matching comment on GET /schedule below.
        const projectIds = [...new Set(orders.map(o => o.projectId).filter(Boolean))];
        let projectInfo = {};
        if (projectIds.length) {
            const projectRows = await sequelize2PetraErp.query(
                `SELECT projectId, projectName, address, mapAddress FROM IIT_Petra.project WHERE projectId IN (:ids)`,
                { replacements: { ids: projectIds }, type: QueryTypes.SELECT }
            );
            projectInfo = Object.fromEntries(projectRows.map(r => [r.projectId, {
                projectName: r.projectName,
                address: r.address,
                mapAddress: r.mapAddress,
            }]));

            // A "-01"/"-02" suffixed projectNo (e.g. "4787-01") is a
            // phase/change-order of the base project ("4787"), not a
            // different site -- confirmed live: 25HR068-01's address was
            // blank while 25HR068 itself had "عمان" filled in. Physical
            // location is very unlikely to change between phases (unlike
            // projectManagerId, confirmed to sometimes legitimately differ
            // per phase -- left untouched, no fallback for that one), so
            // borrow address/mapAddress from the base project when the
            // phase's own row is empty.
            const baseNoToProjectIds = new Map();
            for (const o of orders) {
                const info = o.projectId ? projectInfo[o.projectId] : null;
                if (!info || (info.address && info.mapAddress) || !o.projectNo) continue;
                const baseMatch = o.projectNo.match(/^(.+)-\d+$/);
                if (!baseMatch) continue;
                const baseNo = baseMatch[1];
                if (!baseNoToProjectIds.has(baseNo)) baseNoToProjectIds.set(baseNo, new Set());
                baseNoToProjectIds.get(baseNo).add(o.projectId);
            }
            if (baseNoToProjectIds.size) {
                const baseRows = await sequelize2PetraErp.query(
                    `SELECT projectNo, address, mapAddress FROM IIT_Petra.project WHERE projectNo IN (:nos)`,
                    { replacements: { nos: [...baseNoToProjectIds.keys()] }, type: QueryTypes.SELECT }
                );
                const baseByNo = Object.fromEntries(baseRows.map(r => [r.projectNo, r]));
                for (const [baseNo, pIds] of baseNoToProjectIds) {
                    const base = baseByNo[baseNo];
                    if (!base) continue;
                    for (const pid of pIds) {
                        const info = projectInfo[pid];
                        if (!info.address && base.address) info.address = base.address;
                        if (!info.mapAddress && base.mapAddress) info.mapAddress = base.mapAddress;
                    }
                }
            }

            // mapAddress is a Google Maps URL (e.g.
            // ".../place/Al+Humranyah+Amman/@31.968364,35.8833967,17z") --
            // pull the raw lat/lng out of it rather than surfacing the
            // link itself, plus a human place name when the link embeds
            // one (searched/named place, not a bare dropped pin -- see
            // extractPlaceName). Computed last so it reflects the fallback
            // above too.
            for (const info of Object.values(projectInfo)) {
                info.coordinates = extractCoords(info.mapAddress);
                info.placeName = extractPlaceName(info.mapAddress);
            }

            // Live resolution for a short Google Maps link (an HTTP
            // redirect follow) and reverse geocoding (rate-limited to
            // 1 req/sec, see reverseGeocode.js) used to both run
            // synchronously right here -- confirmed live, a handful of
            // newly-seen projects on one day turned this into a
            // multi-second page load, since the geocode throttle alone
            // adds 1.1s+ per uncached project, one at a time. Only
            // already-cached values are used for THIS response; live
            // resolution for whatever's still missing runs in the
            // background after the response is sent (see
            // resolveMapDataInBackground below), so a repeat load of the
            // same date/projects picks up the warmed cache instead.
            const allProjectIds = Object.keys(projectInfo).map(Number);
            const mapCache = await ProjectMapCache.findAll({ where: { projectId: allProjectIds } });
            const mapCacheByProjectId = new Map(mapCache.map(c => [c.projectId, c]));
            for (const [pidStr, info] of Object.entries(projectInfo)) {
                const hit = mapCacheByProjectId.get(Number(pidStr));
                if (!hit) continue;
                if (!info.coordinates && isShortMapLink(info.mapAddress) && hit.mapAddress === info.mapAddress) {
                    info.coordinates = hit.coordinates;
                    info.placeName = hit.placeName;
                }
                if (info.coordinates && hit.coordinates === info.coordinates && hit.areaName) {
                    info.areaName = hit.areaName;
                }
            }
        }

        // Project managers live in IIT_Petra.user (the older Petra ERP web
        // app's own login table -- distinct from InsUser, which is this
        // app's). Names there are stored in plain English (firstName/
        // lastName), so no charset workaround needed here. Query was fired
        // above, before the projectInfo block, so it's likely already
        // resolved by now.
        const managerRows = await managerNamesPromise;
        const managerNames = Object.fromEntries(managerRows.map(r => [
            r.userId,
            [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.username,
        ]));

        const ordersByTeam = {};
        for (const o of orders) {
            if (!ordersByTeam[o.team_id]) ordersByTeam[o.team_id] = [];
            const info = o.projectId ? projectInfo[o.projectId] : null;
            ordersByTeam[o.team_id].push({
                instOrderId: o.instOrderId,
                orderNumber: o.order_number,
                projectNo: o.projectNo,
                projectName: info?.projectName ?? null,
                location: info?.address ?? null,
                coordinates: info?.coordinates ?? null,
                mapPlaceName: info?.placeName ?? null,
                areaName: info?.areaName ?? null,
                projectManagerName: o.projectManagerId ? (managerNames[o.projectManagerId] ?? null) : null,
                itemCount: Number(o.itemCount) || 0,
            });
        }

        const vacationTeamIds = new Set(vacations.map(v => v.teamId));

        const data = teams.map(t => ({
            teamId: t.id,
            teamName: fixArabic(t.name),
            onVacation: vacationTeamIds.has(t.id),
            orders: ordersByTeam[t.id] || [],
        }));

        res.json({ success: true, data });

        // Fire-and-forget -- must never delay the response above. Only
        // effect is warming ProjectMapCache for the next load of these
        // projects (see resolveMapDataInBackground's own comment).
        if (projectIds.length) {
            resolveMapDataInBackground(projectInfo).catch((err) => {
                console.error('❌ TEAM ROSTER BACKGROUND MAP RESOLUTION ERROR:', err);
            });
        }
    } catch (err) {
        console.error('❌ TEAM ROSTER ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load team roster' });
    }
});

// Live resolution for whatever GET /team-roster's fast, cache-only pass
// couldn't fill in from ProjectMapCache -- short Google Maps links need an
// actual HTTP redirect follow, and reverse geocoding is rate-limited to
// 1 req/sec (see reverseGeocode.js). Previously ran inline in the request
// handler (capped to 5 live geocodes per request to bound the damage),
// which still meant any day with a few newly-seen projects took several
// seconds to load. Called without awaiting its result -- runs after the
// response is already sent, so it's fine for this to take a while on a
// day with many newly-seen projects; it just keeps warming the cache.
async function resolveMapDataInBackground(projectInfo) {
    const pendingShortLinks = Object.entries(projectInfo)
        .filter(([, info]) => !info.coordinates && isShortMapLink(info.mapAddress));
    if (pendingShortLinks.length) {
        const resolved = await Promise.allSettled(
            pendingShortLinks.map(([, info]) => resolveShortMapLink(info.mapAddress))
        );
        for (let i = 0; i < pendingShortLinks.length; i++) {
            const [pidStr, info] = pendingShortLinks[i];
            const result = resolved[i].status === 'fulfilled' ? resolved[i].value : { coordinates: null, placeName: null };
            info.coordinates = result.coordinates;
            info.placeName = result.placeName;
            if (result.coordinates) {
                await ProjectMapCache.upsert({
                    projectId: Number(pidStr),
                    mapAddress: info.mapAddress,
                    coordinates: result.coordinates,
                    placeName: result.placeName,
                    resolvedAt: new Date(),
                });
            }
        }
    }

    const withCoords = Object.entries(projectInfo).filter(([, info]) => info.coordinates && !info.areaName);
    for (const [pidStr, info] of withCoords) {
        const areaName = await reverseGeocodeArea(info.coordinates);
        if (areaName) {
            await ProjectMapCache.upsert({
                projectId: Number(pidStr),
                mapAddress: info.mapAddress,
                coordinates: info.coordinates,
                placeName: info.placeName,
                areaName,
                resolvedAt: new Date(),
            });
        }
    }
}

/* -------------------------------------------------------------
   SCHEDULE: mark/unmark a team as on-vacation for a given day.
   Rejects marking vacation over a day the team already has a real
   order scheduled -- cancel that assignment first, don't leave both
   states true at once.
-------------------------------------------------------------*/
router.post('/team-vacation', async (req, res) => {
    try {
        const { team_id, date, note } = req.body;
        if (!team_id || !date) {
            return res.status(400).json({ success: false, message: 'team_id and date are required' });
        }

        const existingOrder = await sequelize2.query(`
            SELECT id FROM IIT_Petra.instOrders
            WHERE team_id = :team_id AND scheduled_date IS NOT NULL AND CAST(scheduled_date AS DATE) = :date
            LIMIT 1
        `, { replacements: { team_id, date }, type: QueryTypes.SELECT });
        if (existingOrder.length) {
            return res.status(400).json({ success: false, message: 'This team already has a scheduled order that day -- cancel it first' });
        }

        await InstTeamVacation.findOrCreate({
            where: { teamId: team_id, vacationDate: date },
            defaults: { note: note || null, createdByUserId: req.user?.userId ?? null, createdAt: new Date() },
        });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ SET TEAM VACATION ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to mark vacation' });
    }
});

router.delete('/team-vacation', async (req, res) => {
    try {
        const { team_id, date } = req.query;
        if (!team_id || !date) {
            return res.status(400).json({ success: false, message: 'team_id and date are required' });
        }

        await InstTeamVacation.destroy({ where: { teamId: team_id, vacationDate: date } });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ REMOVE TEAM VACATION ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to remove vacation' });
    }
});

/* -------------------------------------------------------------
   4) DELETE ORDER (FULL)
-------------------------------------------------------------*/
router.delete('/:orderId', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { orderId } = req.params;

        const order = await sequelize2.query(`SELECT instReqMasterId FROM IIT_Petra.instOrders WHERE id = :id LIMIT 1`, { replacements: { id: orderId }, type: QueryTypes.SELECT, transaction: trx });
        if (!order.length) {
            await trx.rollback();
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        const { instReqMasterId } = order[0];

        const items = await sequelize2.query(`SELECT instReqDetId FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: orderId }, type: QueryTypes.SELECT, transaction: trx });
        const detIds = items.map(i => i.instReqDetId).filter(Boolean);

        // Scoped to THIS order's own assignment rows, not every row for
        // these instReqDetIds -- an item can now be assigned to more than
        // one team (multi-team support), and a different team's assignment
        // for the same item must survive this order's cancellation. Must
        // run before instOrders itself is deleted below: instReqAssignments'
        // FK on instOrderId is ON DELETE SET NULL, so deleting instOrders
        // first would null these rows out before this WHERE could match them.
        if (detIds.length) {
            await sequelize2.query(`DELETE FROM IIT_Petra.instReqAssignments WHERE instOrderId = :id`, { replacements: { id: orderId }, transaction: trx });
        }

        await sequelize2.query(`DELETE FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`, { replacements: { id: orderId }, transaction: trx });
        await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: orderId }, transaction: trx });

        if (detIds.length) {
            // Only clear the pending-gate flag for items no other team still
            // has assigned.
            const stillAssigned = await sequelize2.query(`SELECT DISTINCT instReqDetId FROM IIT_Petra.instReqAssignments WHERE instReqDetId IN (:ids)`, { replacements: { ids: detIds }, type: QueryTypes.SELECT, transaction: trx });
            const stillAssignedIds = new Set(stillAssigned.map((r) => r.instReqDetId));
            const toClear = detIds.filter((id) => !stillAssignedIds.has(id));
            // Without this, /instOrders/create's own "already assigned" guard
            // would keep silently skipping these items on every future
            // assign attempt, even though the grouped view already shows
            // them as unassigned again.
            if (toClear.length) {
                await sequelize2.query(`UPDATE IIT_Petra.instReqDet SET assignedTeamId = NULL WHERE instReqDetId IN (:ids)`, { replacements: { ids: toClear }, transaction: trx });
            }
        }

        // Same status-revert the per-item unassign path does -- a request
        // that was marked fully assigned needs to go back to "needs
        // assignment" once one of its orders is cancelled.
        if (instReqMasterId) {
            const totalItems = await sequelize2.query(`SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });
            const assignedItems = await sequelize2.query(`SELECT COUNT(DISTINCT a.instReqDetId) AS assigned FROM IIT_Petra.instReqAssignments a JOIN IIT_Petra.instReqDet d ON d.instReqDetId = a.instReqDetId WHERE d.instReqMasterId = :id`, { replacements: { id: instReqMasterId }, type: QueryTypes.SELECT, transaction: trx });
            if (Number(assignedItems[0].assigned) < Number(totalItems[0].total)) {
                await sequelize2.query(`UPDATE IIT_Petra.instReqMaster SET reqStatusId = 1 WHERE instReqMasterId = :id`, { replacements: { id: instReqMasterId }, transaction: trx });
            }
        }

        await trx.commit();
        // Best-effort, outside the transaction above -- InstOrderScheduleDay
        // lives on a separate MySQL connection (sequelizeUtf8), same
        // constraint as recordScheduleDay(). Without this, every day-row
        // this order ever had (see models/InstOrderScheduleDay.js) becomes
        // permanently orphaned: harmless (GET /team-roster INNER JOINs to
        // instOrders, so an orphaned row can never surface), just dead
        // weight left behind on every cancellation.
        InstOrderScheduleDay.destroy({ where: { instOrderId: orderId } }).catch((err) => {
            console.error('❌ CLEANUP SCHEDULE DAYS ERROR:', err);
        });
        notifyOrderUpdate();
        res.json({ success: true, message: 'Order cancelled' });
    } catch (err) {
        await trx.rollback();
        console.error('❌ DELETE ORDER ERROR:', err);
        res.status(500).json({ success: false, message: 'Error cancelling order' });
    }
});

/* -------------------------------------------------------------
   5) GET ALL CREATED & ASSIGNED ORDERS (legacy)
-------------------------------------------------------------*/
router.get('/all-assigned', async (req, res) => {
    try {
        // installation_supervisor only sees orders/teams they supervise
        // (instTeams.supervisor_emp_no) -- same gap/fix as GET /team-roster,
        // /assigned-components, /teams, and /schedule.
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        const orders = await sequelize2.query(`
            SELECT o.id AS instOrderId, o.order_number, o.instReqMasterId, o.team_id, o.scheduled_date, o.note,
                   i.id AS instOrderItemId, i.instReqDetId, i.itemName, i.unitNo, i.height, i.width, i.status,
                   a.id AS assignmentId, a.teamId, a.progressStatus, a.progressPercent
            FROM IIT_Petra.instOrders o
            JOIN IIT_Petra.instOrderItems i ON i.instOrderId = o.id
            LEFT JOIN IIT_Petra.instReqAssignments a ON a.instReqDetId = i.instReqDetId AND a.instOrderId = o.id
            ${isScoped ? 'WHERE o.team_id IN (SELECT id FROM IIT_Petra.instTeams WHERE supervisor_emp_no = :empNo)' : ''}
            ORDER BY o.order_number DESC, i.id ASC
        `, { replacements: { empNo }, type: QueryTypes.SELECT });

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

        const teams = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams ${isScoped ? 'WHERE supervisor_emp_no = :empNo' : ''} ORDER BY id DESC`,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );

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
        // installation_supervisor only sees orders/teams they supervise
        // (instTeams.supervisor_emp_no) -- same gap/fix as GET /team-roster,
        // /assigned-components, /teams, /schedule, and /all-assigned above.
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
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
            ${isScoped ? 'WHERE io.team_id IN (SELECT id FROM IIT_Petra.instTeams WHERE supervisor_emp_no = :empNo)' : ''}
            ORDER BY io.order_number DESC, iod.id ASC
        `, { replacements: { empNo }, type: QueryTypes.SELECT });

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
        const teams = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams ${isScoped ? 'WHERE supervisor_emp_no = :empNo' : ''} ORDER BY id DESC`,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );

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
   COMPONENT-BASED ORDER TRACKING
   Replaces the fixed instSteps checklist with an open-ended list of
   scanned/confirmed component products per unit -- see
   ManageOrdersComponentsPage.tsx. Same instOrderItems/instOrders scope as
   /assigned above, just a different progress model (no "expected total",
   just a running list + count).
-------------------------------------------------------------*/

// GET /instOrders/assigned-components
// Same grouped orders/sections/items shape as /assigned, with each item's
// completion stats (from Stock, the real warehouse allocation -- see
// services/instOrderComponents.js) attached instead of instOrderSteps.
router.get('/assigned-components', async (req, res) => {
    try {
        // installation_supervisor only sees items assigned to teams they
        // supervise (instTeams.supervisor_emp_no) -- same gap as GET
        // /teams and GET /schedule. Naturally excludes not-yet-assigned
        // items too (ira.teamId is NULL for those), which is the right
        // default for a supervisor role -- the Unassigned pool is a
        // manager-level concern.
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        const teamScopeClause = isScoped
            ? 'WHERE ira.teamId IN (SELECT id FROM IIT_Petra.instTeams WHERE supervisor_emp_no = :empNo)'
            : '';

        // Project is resolved via instReqDet -> instReqMaster -> project, not
        // masterControl -- the Unassigned bucket (see selfAssignUnit.js) has
        // no masterControl row behind it (rowId is NULL), so a masterControl-
        // based project join would silently drop it from every project
        // grouping. unitNo falls back to the raw iod.unitNo column for the
        // same reason.
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
                COALESCE(m.unitIdDetail, iod.unitNo) as unitNo,
                iod.height,
                iod.width,
                ira.id AS assignmentId,
                ira.teamId AS assignmentTeamId,
                COALESCE(p.profileSectionName, '') AS sectionName
            FROM IIT_Petra.instOrderItems iod
            LEFT JOIN IIT_Petra.instOrders io ON iod.instOrderId = io.id
            LEFT JOIN IIT_Petra.instReqAssignments ira ON ira.instReqDetId = iod.instReqDetId AND ira.instOrderId = io.id
            LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
            LEFT JOIN IIT_Petra.profileSection p ON m.profileSectionId = p.profileSectionId
            LEFT JOIN IIT_Petra.instReqDet d ON d.instReqDetId = iod.instReqDetId
            LEFT JOIN IIT_Petra.instReqMaster rm ON rm.instReqMasterId = d.instReqMasterId
            LEFT JOIN IIT_Petra.project j ON j.projectId = rm.projectId
            ${teamScopeClause}
            ORDER BY io.id DESC, iod.id ASC
        `, { replacements: { empNo }, type: QueryTypes.SELECT });

        const items = itemsRaw.map(r => ({
            ...r,
            itemName: fixArabic(r.itemName),
            projectName: fixArabic(r.projectName),
        }));

        // One Stock lookup per unit -- getUnitCompletionStats re-resolves the
        // unit's project/UNO itself (already have it in `row` above, but
        // reusing the shared function keeps this in sync with the mobile
        // scan-task endpoint's identical stats rather than two slightly-
        // different implementations). Throttled to a fixed number in flight
        // at once -- a bare Promise.all here fired one SQL Server + one
        // MySQL request per item (2000+ concurrently once real data piled
        // up), blowing well past the mssql pool's default max of 10 and
        // 500ing the whole request on the first pool-acquire timeout.
        const statsEntries = await mapWithConcurrencyLimit(
            items,
            8,
            async (row) => [row.instOrderItemId, await getUnitCompletionStats(row.instOrderItemId)],
        );
        const statsByItem = new Map(statsEntries);

        const orders = {};
        items.forEach(row => {
            const orderId = row.instOrderId;
            const section = row.sectionName || 'Uncategorized';
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
                projectName: row.projectName,
                projectNo: row.projectNo,
                instOrderId: row.instOrderId,
                orderNumber: row.order_number,
                assigned: !!row.assignmentId,
                assignment: row.assignmentId
                    ? { instOrderItemId: row.instOrderItemId, instOrderId: row.instOrderId, teamId: row.assignmentTeamId }
                    : null,
                stats: statsByItem.get(row.instOrderItemId),
            });
        });

        const teams = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams ${isScoped ? 'WHERE supervisor_emp_no = :empNo' : ''} ORDER BY id DESC`,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );

        // Live Team Locations / Field News data -- same sources as /assigned
        // (the old steps-based endpoint), reused as-is: checkpoints (team
        // arrival/departure) are independent of steps vs components, so no
        // separate components version is needed. Same 48h window +
        // UTC_TIMESTAMP() reasoning as /assigned (see comment there).
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

        // Recent component confirm/issue actions (last 48h), the
        // components equivalent of /assigned's recentStepUpdates. Only the
        // raw facts are returned here -- InstOrderComponent lives on a
        // different DB connection (sequelizeUtf8) than instOrderItems, so
        // itemName/project/unit are resolved by the frontend from the
        // `orders` structure above by instOrderItemId, same pattern
        // recentStepUpdates uses for stepName.
        const recentComponents = await InstOrderComponent.findAll({
            where: { updatedAt: { [Op.gte]: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
            order: [['updatedAt', 'DESC']],
            raw: true,
        });
        const confirmerIds = [...new Set(recentComponents.map((c) => c.confirmedByUserId).filter(Boolean))];
        const confirmerUsers = confirmerIds.length
            ? await User.findAll({ where: { userId: confirmerIds }, attributes: ['userId', 'firstName', 'lastName', 'username'], raw: true })
            : [];
        const confirmerNames = Object.fromEntries(
            confirmerUsers.map((u) => [u.userId, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username])
        );
        const recentComponentUpdates = recentComponents.map((c) => ({
            id: c.id,
            instOrderItemId: c.instOrderItemId,
            barcode: c.barcode,
            productName: c.productName,
            status: c.status,
            note: c.note,
            mediaUrl: c.mediaUrl,
            mediaType: c.mediaType,
            confirmedByName: confirmerNames[c.confirmedByUserId] || null,
            updatedAt: c.updatedAt,
        }));

        res.json({ success: true, data: { orders, teams, checkpoints, recentComponentUpdates } });
    } catch (err) {
        console.error('❌ FETCH ASSIGNED COMPONENTS ERROR:', err);
        res.status(500).json({ success: false, message: 'Error fetching assigned orders' });
    }
});

// POST /instOrders/component/confirm
// Body: { instOrderItemId, barcode }. See services/instOrderComponents.js
// for the full validation (project + unit number match against Stock).
router.post('/component/confirm', async (req, res) => {
    try {
        const { instOrderItemId, barcode, note } = req.body;
        if (!instOrderItemId || !barcode) {
            return res.status(400).json({ success: false, message: 'instOrderItemId and barcode are required' });
        }

        const result = await recordComponentAction({
            instOrderItemId,
            barcode,
            action: 'install',
            note,
            userId: req.user.userId,
            empNo: req.user.assignedEmpNo,
        });
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error('❌ CONFIRM COMPONENT ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to confirm component' });
    }
});

// POST /instOrders/component/report-issue
// Body: { instOrderItemId, barcode, note }. Manager-side issue reporting --
// note only, no photo/video (the field-worker mobile route is where media
// capture actually makes sense; see followUp.js's /order-component/report-issue).
router.post('/component/report-issue', async (req, res) => {
    try {
        const { instOrderItemId, barcode, note } = req.body;
        if (!instOrderItemId || !barcode) {
            return res.status(400).json({ success: false, message: 'instOrderItemId and barcode are required' });
        }
        if (!note?.trim()) {
            return res.status(400).json({ success: false, message: 'A note is required to report an issue' });
        }

        const result = await recordComponentAction({
            instOrderItemId,
            barcode,
            action: 'issue',
            note,
            userId: req.user.userId,
            empNo: req.user.assignedEmpNo,
        });
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error('❌ REPORT COMPONENT ISSUE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to report issue' });
    }
});

// POST /instOrders/component/mark-complete
// Body: { instOrderItemId }. Explicit sign-off, only allowed once every
// allocated material is Installed with no open Issue -- see
// services/instOrderComponents.js's markUnitComplete for the guard.
router.post('/component/mark-complete', async (req, res) => {
    try {
        const { instOrderItemId } = req.body;
        if (!instOrderItemId) {
            return res.status(400).json({ success: false, message: 'instOrderItemId is required' });
        }
        const result = await markUnitComplete(instOrderItemId);
        if (result.status === 'OK') notifyOrderUpdate();
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
    } catch (err) {
        console.error('❌ MARK UNIT COMPLETE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to mark unit complete' });
    }
});

// DELETE /instOrders/component/:id
// Removes a mistaken confirmation -- deliberately a hard delete, not a
// status flag, since a wrongly-confirmed component isn't a real event
// worth retaining in the trail (compare instOrderStepUpdates, which is
// append-only because every step transition IS a real event).
router.delete('/component/:id', async (req, res) => {
    try {
        const deleted = await InstOrderComponent.destroy({ where: { id: req.params.id } });
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Component not found' });
        }
        notifyOrderUpdate();
        res.json({ success: true });
    } catch (err) {
        console.error('❌ DELETE COMPONENT ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to remove component' });
    }
});

/* -------------------------------------------------------------
   GM DASHBOARD SUMMARY -- company-wide, unscoped (no per-supervisor/team
   filtering, unlike e.g. team-roster), four cheap counts for a landing-page
   overview rather than a detailed report:
     - pendingOrders: orders with at least one unit not yet marked done
       (same "not done" criteria AT_RISK_THRESHOLD_DAYS's query below uses)
     - deliveredToday: InsDelivered rows confirmed today -- deliberately
       "today's activity" rather than an all-time total, which needs the
       heavier UNO-matching /reports/delivery-status does and isn't
       meaningful as a single running number on a dashboard tile
     - activeTeams / totalTeams: teams currently checked in to a project
       right now (most recent instTeamCheckpoints row is 'inProject'), same
       resolution followUp.js's /team/checkin-status and /delivered-items
       use for a single team -- here done for every team at once
--------------------------------------------------------------*/
router.get('/gm-summary', async (req, res) => {
    try {
        const [pendingOrdersRows, deliveredTodayRows, teamCheckpointRows, totalTeamsRows] = await Promise.all([
            sequelize2.query(
                `SELECT COUNT(DISTINCT instOrderId) AS c FROM IIT_Petra.instOrderItems WHERE status IS NULL OR status != 'done'`,
                { type: QueryTypes.SELECT }
            ),
            sequelize2.query(
                `SELECT COUNT(*) AS c FROM IIT_Petra.InsDelivered WHERE InsStatus = 'DELIVERED' AND DATE(InsDeliverdDate) = CURDATE()`,
                { type: QueryTypes.SELECT }
            ),
            sequelize2.query(
                `
                SELECT t1.team_id, t1.checkpoint_type
                FROM IIT_Petra.instTeamCheckpoints t1
                INNER JOIN (
                    SELECT team_id, MAX(id) AS maxId
                    FROM IIT_Petra.instTeamCheckpoints
                    WHERE checkpoint_type IN ('inProject', 'outProject')
                    GROUP BY team_id
                ) t2 ON t2.team_id = t1.team_id AND t2.maxId = t1.id
                `,
                { type: QueryTypes.SELECT }
            ),
            sequelize.query(`SELECT COUNT(*) AS c FROM IIT_Petra.instTeams`, { type: QueryTypes.SELECT }),
        ]);

        const activeTeams = teamCheckpointRows.filter((r) => r.checkpoint_type === 'inProject').length;

        res.json({
            success: true,
            data: {
                pendingOrders: Number(pendingOrdersRows[0].c) || 0,
                deliveredToday: Number(deliveredTodayRows[0].c) || 0,
                activeTeams,
                totalTeams: Number(totalTeamsRows[0].c) || 0,
            },
        });
    } catch (err) {
        console.error('❌ GM SUMMARY ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load dashboard summary' });
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
   Flags orders that still have unfinished units close to (or past) their
   scheduled_date. Component-based tracking has no per-item standard-time
   figure to project a precise "days needed" from (materials are scanned
   freely, not against a timed checklist), so this uses a coarser but
   honest signal instead of fake precision: an order is at-risk if it has
   any unit not yet marked done (instOrderItems.status, set by
   markUnitComplete in services/instOrderComponents.js) and its scheduled
   date is within AT_RISK_THRESHOLD_DAYS or already passed.
--------------------------------------------------------------*/
const AT_RISK_THRESHOLD_DAYS = 2;

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
            SELECT instOrderId, COUNT(*) AS remainingCount
            FROM IIT_Petra.instOrderItems
            WHERE status IS NULL OR status != 'done'
            GROUP BY instOrderId
            `,
            { type: QueryTypes.SELECT }
        );
        const remainingByOrder = new Map(remaining.map(r => [r.instOrderId, Number(r.remainingCount) || 0]));

        const now = new Date();
        const data = orders
            .map(o => {
                const remainingCount = remainingByOrder.get(o.instOrderId) || 0;
                const scheduledDate = new Date(o.scheduled_date);
                const daysRemaining = Math.ceil((scheduledDate - now) / (1000 * 60 * 60 * 24));
                return {
                    orderId: o.instOrderId,
                    orderNumber: o.order_number,
                    projectName: fixArabic(o.projectName),
                    projectNo: o.projectNo,
                    scheduledDate: o.scheduled_date,
                    remainingCount,
                    daysRemaining,
                    atRisk: remainingCount > 0 && daysRemaining >= 0 && daysRemaining <= AT_RISK_THRESHOLD_DAYS,
                    overdue: remainingCount > 0 && daysRemaining < 0,
                };
            })
            // Only orders with remaining work are meaningful here — fully
            // completed orders can't be "at risk."
            .filter(o => o.remainingCount > 0)
            .sort((a, b) => a.daysRemaining - b.daysRemaining);

        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ AT-RISK REPORT ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to build at-risk report' });
    }
});


/* -------------------------------------------------------------
   SCHEDULE: search ANY project in the system, including ones with no
   installation request (instReqMaster) submitted for them at all --
   backs the Schedule page's "Special add" escape hatch (see
   projectId handling in POST /create) for one-off/ad-hoc site work
   outside the normal Petra ERP request pipeline. Unlike
   /all-requests, this is a live search (not a full list) since the
   project table has thousands of rows.
-------------------------------------------------------------*/
router.get('/projects-search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) {
            return res.json({ success: true, data: [] });
        }
        // Project's connection (sequelize2PetraErp) declares a latin1
        // client charset so it can correctly re-decode legacy Arabic text
        // that's actually stored as raw UTF-8 bytes under latin1 columns
        // (see the typeCast comment in config/db.js) -- but that same
        // charset setting mangles a *fresh* Arabic search string on the way
        // OUT, since mysql2 encodes outgoing parameters using the
        // connection's declared charset. Mirroring the read-side fix in
        // reverse (UTF-8 bytes reinterpreted as a raw/binary JS string)
        // makes the outgoing bytes match what's actually on disk.
        const wireQ = Buffer.from(q, 'utf8').toString('binary');
        const rows = await Project.findAll({
            attributes: ['projectId', 'projectNo', 'projectName'],
            where: {
                hidden: 0,
                [Op.or]: [
                    { statusId: null },
                    { statusId: { [Op.ne]: 7 } },
                ],
                [Op.and]: [
                    {
                        [Op.or]: [
                            { projectNo: { [Op.like]: `%${wireQ}%` } },
                            { projectName: { [Op.like]: `%${wireQ}%` } },
                        ],
                    },
                ],
            },
            order: [['projectId', 'DESC']],
            limit: 50,
        });
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('❌ PROJECTS-SEARCH ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to search projects' });
    }
});

/* -------------------------------------------------------------
   SCHEDULE: every installation request/project, regardless of
   pending items -- for the Schedule page's "visit only" quick-assign
   mode (send a team to a project to check the site, not to install
   anything, so it shouldn't be limited to projects with unassigned
   items like /requests-with-pending is).
-------------------------------------------------------------*/
router.get('/all-requests', async (req, res) => {
    try {
        const rows = await sequelize2.query(`
            SELECT m.instReqMasterId, m.projectId, p.projectNo
            FROM IIT_Petra.instReqMaster m
            LEFT JOIN IIT_Petra.project p ON p.projectId = m.projectId
            ORDER BY m.instReqMasterId DESC
        `, { type: QueryTypes.SELECT });

        const projectIds = [...new Set(rows.map(r => r.projectId).filter(Boolean))];
        let projectNames = {};
        if (projectIds.length) {
            const projectRows = await sequelize2PetraErp.query(
                `SELECT projectId, projectName FROM IIT_Petra.project WHERE projectId IN (:ids)`,
                { replacements: { ids: projectIds }, type: QueryTypes.SELECT }
            );
            projectNames = Object.fromEntries(projectRows.map(r => [r.projectId, r.projectName]));
        }

        const data = rows.map(r => ({
            instReqMasterId: r.instReqMasterId,
            projectId: r.projectId,
            projectNo: r.projectNo,
            projectName: r.projectId ? (projectNames[r.projectId] ?? null) : null,
        }));

        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ ALL-REQUESTS ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load requests' });
    }
});

/* -------------------------------------------------------------
   SCHEDULE: installation requests that still have at least one
   unassigned item, for the Schedule page's quick-assign project
   picker (assign a whole request/project to a team + date in one
   step, rather than opening AssignTeam.tsx and hand-picking items).
-------------------------------------------------------------*/
router.get('/requests-with-pending', async (req, res) => {
    try {
        const rows = await sequelize2.query(`
            SELECT m.instReqMasterId, m.projectId, p.projectNo, COUNT(*) AS pendingCount
            FROM IIT_Petra.instReqDet d
            JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = d.instReqMasterId
            LEFT JOIN IIT_Petra.project p ON p.projectId = m.projectId
            WHERE d.assignedTeamId IS NULL
            GROUP BY m.instReqMasterId, m.projectId, p.projectNo
            ORDER BY m.instReqMasterId DESC
        `, { type: QueryTypes.SELECT });

        // projectName needs the PetraErp-charset connection -- see the
        // matching comment in GET /schedule below.
        const projectIds = [...new Set(rows.map(r => r.projectId).filter(Boolean))];
        let projectNames = {};
        if (projectIds.length) {
            const projectRows = await sequelize2PetraErp.query(
                `SELECT projectId, projectName FROM IIT_Petra.project WHERE projectId IN (:ids)`,
                { replacements: { ids: projectIds }, type: QueryTypes.SELECT }
            );
            projectNames = Object.fromEntries(projectRows.map(r => [r.projectId, r.projectName]));
        }

        const data = rows.map(r => ({
            instReqMasterId: r.instReqMasterId,
            projectId: r.projectId,
            projectNo: r.projectNo,
            projectName: r.projectId ? (projectNames[r.projectId] ?? null) : null,
            pendingCount: Number(r.pendingCount) || 0,
        }));

        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ REQUESTS-WITH-PENDING ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load pending requests' });
    }
});

/* -------------------------------------------------------------
   SCHEDULE: orders with a scheduled_date in range, for the Schedule
   page's day -> team -> project agenda. Project/order level only --
   one row per instOrders record, not the per-item breakdown
   /grouped and AssignTeam.tsx deal with.
-------------------------------------------------------------*/
router.get('/schedule', async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) {
            return res.status(400).json({ success: false, message: 'from and to query params are required (YYYY-MM-DD)' });
        }

        // installation_supervisor only sees schedule entries/teams they
        // supervise (instTeams.supervisor_emp_no) -- previously unscoped,
        // same gap as GET /teams (see routes/teams.js).
        const isScoped = req.user.role === 'installation_supervisor';
        const empNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        const teamScopeClause = isScoped ? 'AND t.supervisor_emp_no = :empNo' : '';

        const orders = await sequelize2.query(`
            SELECT
                o.id AS instOrderId,
                o.order_number,
                o.instReqMasterId,
                o.team_id,
                o.scheduled_date,
                o.status,
                o.note,
                t.name AS teamName,
                m.projectId,
                p.projectNo,
                (SELECT COUNT(*) FROM IIT_Petra.instOrderItems ii WHERE ii.instOrderId = o.id) AS itemCount
            FROM IIT_Petra.instOrders o
            LEFT JOIN IIT_Petra.instTeams t ON t.id = o.team_id
            LEFT JOIN IIT_Petra.instReqMaster m ON m.instReqMasterId = o.instReqMasterId
            LEFT JOIN IIT_Petra.project p ON p.projectId = m.projectId
            WHERE o.scheduled_date IS NOT NULL
              AND o.scheduled_date BETWEEN :from AND :to
              ${teamScopeClause}
            ORDER BY o.scheduled_date ASC, o.id ASC
        `, { replacements: { from, to, empNo }, type: QueryTypes.SELECT });

        const teams = await sequelize2.query(
            `SELECT id, name FROM IIT_Petra.instTeams ${isScoped ? 'WHERE supervisor_emp_no = :empNo' : ''} ORDER BY name ASC`,
            { replacements: { empNo }, type: QueryTypes.SELECT }
        );

        // projectName specifically needs the PetraErp-charset connection
        // (see config/db.js's sequelize2PetraErp comment) -- plain
        // sequelize2 mojibakes it, unlike instTeams.name/instOrders fields
        // above which round-trip fine through fixArabic() on this
        // connection, so only this one lookup is split out rather than
        // switching the whole query's connection.
        const projectIds = [...new Set(orders.map(o => o.projectId).filter(Boolean))];
        let projectNames = {};
        if (projectIds.length) {
            const projectRows = await sequelize2PetraErp.query(
                `SELECT projectId, projectName FROM IIT_Petra.project WHERE projectId IN (:ids)`,
                { replacements: { ids: projectIds }, type: QueryTypes.SELECT }
            );
            projectNames = Object.fromEntries(projectRows.map(r => [r.projectId, r.projectName]));
        }

        const data = orders.map(o => ({
            instOrderId: o.instOrderId,
            orderNumber: o.order_number,
            instReqMasterId: o.instReqMasterId,
            teamId: o.team_id,
            teamName: o.teamName ? fixArabic(o.teamName) : null,
            scheduledDate: o.scheduled_date,
            status: o.status,
            note: o.note,
            projectNo: o.projectNo,
            projectName: o.projectId ? (projectNames[o.projectId] ?? null) : null,
            itemCount: Number(o.itemCount) || 0,
        }));

        res.json({ success: true, data, teams: teams.map(t => ({ id: t.id, name: fixArabic(t.name) })) });
    } catch (err) {
        console.error('❌ SCHEDULE FETCH ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load schedule' });
    }
});

/* -------------------------------------------------------------
   SCHEDULE: reassign an order's team and/or scheduled date at the
   project/order level. Keeps instReqAssignments.teamId (the real
   per-item source of truth used by progress tracking, the mobile
   scan flow, and the live team map) in sync with the order-level
   team_id -- without this, every other view would keep showing the
   old team for these items even though the order header says
   otherwise.
-------------------------------------------------------------*/
router.patch('/:id/schedule', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { id } = req.params;
        const { team_id, scheduled_date } = req.body;

        const orderRows = await sequelize2.query(
            `SELECT id, team_id, scheduled_date FROM IIT_Petra.instOrders WHERE id = :id LIMIT 1`,
            { replacements: { id }, type: QueryTypes.SELECT, transaction: trx }
        );
        if (!orderRows.length) {
            await trx.rollback();
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const updates = [];
        const replacements = { id };

        if (team_id !== undefined && Number(team_id) !== Number(orderRows[0].team_id)) {
            const leaderRes = await sequelize2.query(
                `SELECT leader_emp_no FROM IIT_Petra.instTeams WHERE id = :teamId LIMIT 1`,
                { replacements: { teamId: team_id }, type: QueryTypes.SELECT, transaction: trx }
            );
            if (!leaderRes.length) {
                await trx.rollback();
                return res.status(404).json({ success: false, message: 'Team not found' });
            }
            updates.push('team_id = :team_id', 'assignedEmpNo = :leaderEmpNo');
            replacements.team_id = team_id;
            replacements.leaderEmpNo = leaderRes[0].leader_emp_no || null;

            await sequelize2.query(
                `UPDATE IIT_Petra.instReqAssignments SET teamId = :team_id WHERE instOrderId = :id`,
                { replacements: { team_id, id }, transaction: trx }
            );
        }

        if (scheduled_date !== undefined) {
            updates.push('scheduled_date = :scheduled_date');
            replacements.scheduled_date = scheduled_date || null;
        }

        if (updates.length) {
            updates.push('updated_at = NOW()');
            await sequelize2.query(
                `UPDATE IIT_Petra.instOrders SET ${updates.join(', ')} WHERE id = :id`,
                { replacements, transaction: trx }
            );
        }

        await trx.commit();
        // Resolved to whichever value is now current -- either just changed
        // above, or untouched from before (a caller only changing the date
        // still needs today's already-set team recorded against the new
        // date, and vice versa).
        const finalTeamId = team_id !== undefined ? team_id : orderRows[0].team_id;
        const finalScheduledDate = scheduled_date !== undefined ? scheduled_date : orderRows[0].scheduled_date;
        await recordScheduleDay(id, finalTeamId, finalScheduledDate, req.user?.userId);
        notifyOrderUpdate();
        res.json({ success: true });
    } catch (err) {
        await trx.rollback();
        console.error('❌ SCHEDULE UPDATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to update schedule' });
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
