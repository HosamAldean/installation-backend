// backend/services/selfAssignUnit.js
// Lets a field worker (team leader) claim a scanned unit for their own
// team directly from the mobile app, instead of waiting for a manager to
// assign it via the web ManageOrders "create" flow. Two things this
// mirrors from instOrders.js's POST /instOrders/create (for exactly one
// item instead of a batch):
//   - if the unit's instReqDet row has never been turned into an
//     instOrderItems/instReqAssignments row at all, the full chain
//     (instOrders header, instOrderItems, instOrderDetails,
//     instReqAssignments) is created from scratch;
//   - if it already has one (assigned to no one, or to a different team),
//     the existing instReqAssignments row is reassigned in place instead
//     of creating a duplicate second instOrderItems row for the same
//     instReqDet.
// Deliberately restricted to units in a project the worker's team already
// has at least one other assignment in -- otherwise any team leader could
// grab any unit company-wide cold, which is a real business-process
// change the user explicitly scoped down to "same project only".
import { sequelize, sequelize2 } from '../config/db.js';
import { QueryTypes } from 'sequelize';
import { withSqlRetry } from '../config/db.js';
import { normalizeUnitNo, UNASSIGNED_UNIT_NO } from './instOrderComponents.js';
import { toLegacyArabicStorage } from '../utils/fixArabic.js';
import { recordScheduleDay, notifyOrderUpdate } from '../routes/instOrders.js';
import { toDateOnlyString } from '../utils/dateOnly.js';

const normalizeProjectNo = (value) =>
    String(value || '')
        .replace(/\s+/g, '')
        .split('-')[0]
        .replace(/\.0$/, '')
        .trim()
        .toUpperCase();

async function resolveTeamIdForUser(reqUser) {
    if (reqUser.teamId) return reqUser.teamId;
    if (!reqUser.assignedEmpNo) return null;
    const rows = await sequelize.query(
        `SELECT id FROM IIT_Petra.instTeams WHERE leader_emp_no = :assignedEmpNo LIMIT 1`,
        { replacements: { assignedEmpNo: reqUser.assignedEmpNo }, type: QueryTypes.SELECT }
    );
    return rows[0]?.id || null;
}

// Finds this team's existing self-assigned order for this instReqMaster
// (order_number = 0, see the order-creation comments below) and reuses it
// if one already exists, instead of creating a brand new instOrders header
// every time a unit is self-assigned -- confirmed live that without this,
// two separate self-assigns from the same team into the same project
// produced two distinct orders (order_number 0 twice, e.g. orders #3 and
// #4) on the manager's Manage Orders Components page, instead of the one
// consolidated order the business actually wants per team+project.
// Every self-assign (creating this order fresh, or a later one reusing it)
// counts as this team working this project TODAY -- scheduled_date used to
// be left NULL here entirely and InstOrderScheduleDay never written, so a
// self-assigned order was real (showed up as "assigned" everywhere else)
// but permanently invisible on the Schedule page's day-by-day roster,
// which joins through InstOrderScheduleDay/reads scheduled_date --
// confirmed live (order_number 0, scheduled_date NULL, no
// InstOrderScheduleDay row at all).
//
// recordScheduleDay writes to sequelizeUtf8, a separate connection/pool
// from this file's own sequelize2 transactions (same reason
// routes/instOrders.js's own callers only invoke it after trx.commit(),
// see that function's comment) -- findOrCreateSelfAssignOrder runs inside
// an in-progress trx that might still roll back, so it only returns which
// (instOrderId, teamId) needs a day recorded; each call site records it
// itself once its own trx has actually committed.
async function findOrCreateSelfAssignOrder({ instReqMasterId, teamId, empNo, note, trx, today }) {
    const existing = await sequelize2.query(
        `SELECT id FROM IIT_Petra.instOrders WHERE instReqMasterId = :instReqMasterId AND team_id = :teamId AND order_number = 0 LIMIT 1`,
        { replacements: { instReqMasterId, teamId }, type: QueryTypes.SELECT, transaction: trx }
    );
    if (existing.length) {
        const instOrderId = existing[0].id;
        // Advance scheduled_date to today, same "latest known state"
        // convention POST /instOrders/create and PATCH /:id/schedule
        // already follow -- a team still self-assigning units into this
        // order days later should show as working it today, not whatever
        // day it was first created.
        await sequelize2.query(
            `UPDATE IIT_Petra.instOrders SET scheduled_date = :today, updated_at = NOW() WHERE id = :instOrderId`,
            { replacements: { today, instOrderId }, transaction: trx }
        );
        return { instOrderId, teamId, today };
    }

    await sequelize2.query(
        `
        INSERT INTO IIT_Petra.instOrders
        (instReqMasterId, team_id, assignedEmpNo, order_number, status, assigned_date, scheduled_date, note, created_at, updated_at)
        VALUES (:instReqMasterId, :teamId, :empNo, 0, 'assigned', NOW(), :today, :note, NOW(), NOW())
        `,
        { replacements: { instReqMasterId, teamId, empNo, note, today }, transaction: trx }
    );
    const header = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
    return { instOrderId: header[0].id, teamId, today };
}

export async function selfAssignUnit({ barcode, reqUser }) {
    const cleanBarcode = parseInt(barcode, 10);
    if (!Number.isInteger(cleanBarcode)) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Item not found in warehouse' };
    }

    const teamId = await resolveTeamIdForUser(reqUser);
    if (!teamId) {
        return { success: true, httpStatus: 403, status: 'NO_TEAM', message: 'Only a team leader can self-assign units' };
    }

    // Same source scan-task itself resolves barcodes against (the `out`
    // shipment log) -- this endpoint is only ever called as a follow-up to
    // a NOT_ASSIGNED scan-task response for the same barcode, so it needs
    // to resolve to the same project/unit scan-task just saw.
    const stockResult = await withSqlRetry('minstock', (pool) => pool.request()
        .input('barcode', cleanBarcode)
        .query(`SELECT TOP 1 * FROM out WHERE barcode = @barcode`));
    if (!stockResult.recordset.length) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Item not found in warehouse' };
    }
    const stock = stockResult.recordset[0];
    // Unit numbers are frequently alphanumeric ("CW-7", "8.1", etc) -- a
    // bare parseInt (the original implementation) returns NaN for all of
    // those and silently reports NOT_FOUND for a real, in-stock unit. See
    // normalizeUnitNo in instOrderComponents.js for the full rationale.
    // An empty wantUnit means the warehouse never recorded a UNO for this
    // item at all (a real, separate data gap -- confirmed live) -- handled
    // below via the per-project "Unassigned" bucket instead of NOT_FOUND.
    const wantUnit = normalizeUnitNo(stock.UNO);
    const wantProject = normalizeProjectNo(stock.projNo);
    if (!wantProject) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Item not found in warehouse' };
    }

    // "Same project only" guard: the team must already have at least one
    // other assignment in this project before they can self-assign a new
    // unit into it. Resolved via instReqDet -> instReqMaster -> project
    // (not masterControl) so it still counts assignments that belong to
    // the no-unit "Unassigned" bucket (its rowId is NULL, so a
    // masterControl-based join would silently drop it).
    const existingProjectAssignments = await sequelize.query(
        `
        SELECT DISTINCT p.projectNo
        FROM IIT_Petra.instReqAssignments ira
        JOIN IIT_Petra.instReqDet d ON d.instReqDetId = ira.instReqDetId
        JOIN IIT_Petra.instReqMaster rm ON rm.instReqMasterId = d.instReqMasterId
        JOIN IIT_Petra.project p ON p.projectId = rm.projectId
        WHERE ira.teamId = :teamId
        `,
        { replacements: { teamId }, type: QueryTypes.SELECT }
    );
    const teamHasProject = existingProjectAssignments.some(
        (r) => normalizeProjectNo(r.projectNo) === wantProject
    );
    if (!teamHasProject) {
        return {
            success: true,
            httpStatus: 403,
            status: 'DIFFERENT_PROJECT',
            message: 'You can only self-assign units in a project your team is already working on',
        };
    }

    if (!wantUnit || wantUnit === '0') {
        return selfAssignUnassignedItem({ teamId, wantProject, reqUser, barcode: cleanBarcode, stock });
    }

    // Scoped by project prefix in SQL (masterControl.unitIdDetail formatting
    // varies too much -- "CW07" vs Stock's "CW-7" -- for a clean exact-match
    // WHERE clause), then matched precisely in JS with normalizeUnitNo,
    // mirroring fetchAllocatedMaterials's fix in instOrderComponents.js.
    const masterRows = await sequelize.query(
        `
        SELECT m.rowId, m.unitShapeId, m.height, m.width, m.orderId, o.orderNumber, s.descAr AS itemName, p.projectNo, m.unitIdDetail
        FROM IIT_Petra.masterControl m
        JOIN IIT_Petra.project p ON p.projectId = m.projectId
        LEFT JOIN IIT_Petra.unitShapes s ON s.unitShapeId = m.unitShapeId
        LEFT JOIN IIT_Petra.orders o ON o.orderId = m.orderId
        WHERE p.projectNo LIKE :projPrefix
        `,
        { replacements: { projPrefix: `${wantProject}%` }, type: QueryTypes.SELECT }
    );
    // Unit numbers are NOT guaranteed unique within a project -- confirmed
    // live (e.g. project 25HR068-01 has two entirely distinct masterControl
    // rows both labeled unit "1"). scan-task's read-only lookup can get
    // away with "first match wins" since it's already scoped to the
    // worker's own assigned items, but self-assign is a write with real
    // consequences and searches unscoped across the whole project, so an
    // ambiguous match here is refused outright rather than silently
    // guessing which physical unit the barcode meant.
    const projectMatches = masterRows.filter((r) =>
        normalizeProjectNo(r.projectNo) === wantProject && normalizeUnitNo(r.unitIdDetail) === wantUnit
    );
    if (projectMatches.length === 0) {
        // Known numbering mismatch between the factory floor's unit labels
        // (Stock.UNO, e.g. "5-W02A-B") and Petra ERP's own masterControl
        // unitIdDetail labels for the same physical units (e.g. "05") --
        // confirmed live, no recorded mapping between the two schemes
        // exists yet. If this barcode's production number nonetheless
        // matches a real order already in this project, that's real
        // signal it genuinely belongs here even though its unit label
        // can't be matched -- rather than refuse outright, fall into the
        // same per-barcode "Unassigned" bucket used for items with no UNO
        // at all (scoped to this one barcode, never claims sibling
        // materials under the same order). Until the numbering is fixed
        // at the source, this is a deliberate stopgap, not a guess at
        // which specific unit it is.
        const productionNo = String(stock.ProdctionNO || '').trim();
        const orderConfirmed = productionNo && masterRows.some((r) =>
            normalizeProjectNo(r.projectNo) === wantProject && String(r.orderNumber ?? '').trim() === productionNo
        );
        if (orderConfirmed) {
            return selfAssignUnassignedItem({ teamId, wantProject, reqUser, barcode: cleanBarcode, stock });
        }
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Unit not found for this project' };
    }
    if (projectMatches.length > 1) {
        return {
            success: true,
            httpStatus: 200,
            status: 'AMBIGUOUS',
            message: 'Multiple units share this number in this project -- ask a manager to assign this one',
            // Nothing here is safe to auto-pick between (that's the whole
            // reason this is refused rather than guessed) -- surfaced so the
            // worker has concrete details to relay to their manager instead
            // of just "it's ambiguous".
            candidates: projectMatches.map((r) => ({
                orderNumber: r.orderNumber ?? null,
                itemName: r.itemName ?? null,
                height: r.height ?? null,
                width: r.width ?? null,
            })),
        };
    }
    const master = projectMatches[0];

    const detRows = await sequelize2.query(
        `SELECT instReqDetId, instReqMasterId, assignedTeamId FROM IIT_Petra.instReqDet WHERE rowId = :rowId LIMIT 1`,
        { replacements: { rowId: master.rowId }, type: QueryTypes.SELECT }
    );
    const det = detRows[0];
    if (!det) {
        return {
            success: true,
            httpStatus: 200,
            status: 'NOT_REQUESTED',
            message: 'This unit has not been requested for installation yet',
            // Same reasoning as AMBIGUOUS's candidates -- there's no write
            // action mobile can safely take here (creating an install
            // request is a PM/web-side decision), so give the worker
            // concrete details to relay instead of a bare rejection.
            unit: {
                orderNumber: master.orderNumber ?? null,
                itemName: master.itemName ?? null,
                unitNo: master.unitIdDetail ?? null,
            },
        };
    }

    if (det.assignedTeamId === teamId) {
        const existingItem = await sequelize2.query(
            `SELECT id FROM IIT_Petra.instOrderItems WHERE instReqDetId = :detId LIMIT 1`,
            { replacements: { detId: det.instReqDetId }, type: QueryTypes.SELECT }
        );
        return {
            success: true,
            httpStatus: 200,
            status: 'ALREADY_YOURS',
            message: 'This unit is already assigned to your team',
            instOrderItemId: existingItem[0]?.id || null,
        };
    }

    const trx = await sequelize2.transaction();
    // See findOrCreateSelfAssignOrder's own comment: recordScheduleDay
    // writes to a different connection than trx, so every branch below
    // just notes which (instOrderId, teamId) it touched and the actual
    // recording happens once, after trx.commit() succeeds.
    const today = toDateOnlyString(new Date());
    let scheduleTarget = null;
    try {
        const existingAssignment = await sequelize2.query(
            `SELECT id FROM IIT_Petra.instReqAssignments WHERE instReqDetId = :detId LIMIT 1`,
            { replacements: { detId: det.instReqDetId }, type: QueryTypes.SELECT, transaction: trx }
        );

        let instOrderItemId;
        if (existingAssignment.length) {
            await sequelize2.query(
                `UPDATE IIT_Petra.instReqAssignments SET teamId = :teamId, assignedEmpNo = :empNo, assignedBy = :by, assignedAt = NOW() WHERE id = :id`,
                {
                    replacements: {
                        teamId,
                        empNo: reqUser.assignedEmpNo,
                        by: reqUser.userId ?? null,
                        id: existingAssignment[0].id,
                    },
                    transaction: trx,
                }
            );
            const items = await sequelize2.query(
                `SELECT id, instOrderId FROM IIT_Petra.instOrderItems WHERE instReqDetId = :detId LIMIT 1`,
                { replacements: { detId: det.instReqDetId }, type: QueryTypes.SELECT, transaction: trx }
            );
            instOrderItemId = items[0]?.id || null;
            const oldInstOrderId = items[0]?.instOrderId;

            // Mirror the order header's own team_id/assignedEmpNo, same
            // invariant PATCH /:id/schedule enforces in the opposite
            // direction (see its own comment) -- without this, the order
            // still shows its original team everywhere that reads
            // instOrders.team_id directly (web ManageOrders/AssignTeam/
            // LiveTeamMap) even though instReqAssignments now says
            // otherwise, so the item never visibly "moves" for the team
            // that just claimed it.
            if (oldInstOrderId) {
                const siblingCount = await sequelize2.query(
                    `SELECT COUNT(*) AS cnt FROM IIT_Petra.instOrderItems WHERE instOrderId = :oldInstOrderId`,
                    { replacements: { oldInstOrderId }, type: QueryTypes.SELECT, transaction: trx }
                );
                if (Number(siblingCount[0].cnt) <= 1) {
                    // Only item on its order -- safe to flip the header itself.
                    // scheduled_date advances to today too, same reasoning as
                    // findOrCreateSelfAssignOrder's reuse branch -- this order
                    // is now this team's work for today, not whatever day it
                    // was originally scheduled for.
                    await sequelize2.query(
                        `UPDATE IIT_Petra.instOrders SET team_id = :teamId, assignedEmpNo = :empNo, scheduled_date = :today, updated_at = NOW() WHERE id = :oldInstOrderId`,
                        {
                            replacements: { teamId, empNo: reqUser.assignedEmpNo, oldInstOrderId, today },
                            transaction: trx,
                        }
                    );
                    scheduleTarget = { instOrderId: oldInstOrderId, teamId };
                } else {
                    // This item shares its order header with other items
                    // still legitimately owned by the old team (a batch
                    // order created via the web ManageOrders flow) --
                    // flipping the shared header's team_id would wrongly
                    // "move" those untouched siblings too. Split just this
                    // one item out instead, into this team's existing
                    // self-assigned order for this request if it already
                    // has one (order_number = 0 -- purely a visual marker,
                    // no uniqueness assumed or enforced on it -- confirmed
                    // live it has only a plain, non-unique index), or a new
                    // one otherwise -- leaving the shared header and its
                    // other items alone.
                    const split = await findOrCreateSelfAssignOrder({
                        instReqMasterId: det.instReqMasterId,
                        teamId,
                        empNo: reqUser.assignedEmpNo,
                        note: 'Self-assigned from mobile scan (split from a shared order)',
                        trx,
                        today,
                    });
                    const newInstOrderId = split.instOrderId;
                    scheduleTarget = { instOrderId: newInstOrderId, teamId };

                    await sequelize2.query(
                        `UPDATE IIT_Petra.instOrderItems SET instOrderId = :newInstOrderId WHERE id = :instOrderItemId`,
                        { replacements: { newInstOrderId, instOrderItemId }, transaction: trx }
                    );
                    // instReqAssignments.instOrderId must move with it --
                    // resolveTeamIdForItem/my-orders/my-order-components all
                    // join ira.instOrderId = instOrderItems.instOrderId, so
                    // leaving this on the old header would break that join.
                    await sequelize2.query(
                        `UPDATE IIT_Petra.instReqAssignments SET instOrderId = :newInstOrderId WHERE id = :assignmentId`,
                        { replacements: { newInstOrderId, assignmentId: existingAssignment[0].id }, transaction: trx }
                    );
                }
            }
        } else {
            // Reuse this team's existing self-assigned order for this same
            // request (order_number = 0 -- see the comment on the split-
            // order branch above) if one already exists, instead of
            // creating a new order header for every individually
            // self-assigned unit -- keeps them consolidated into one order
            // on the manager's Manage Orders Components page.
            const created = await findOrCreateSelfAssignOrder({
                instReqMasterId: det.instReqMasterId,
                teamId,
                empNo: reqUser.assignedEmpNo,
                note: 'Self-assigned from mobile scan',
                trx,
                today,
            });
            const instOrderId = created.instOrderId;
            scheduleTarget = { instOrderId, teamId };

            await sequelize2.query(
                `
                INSERT INTO IIT_Petra.instOrderItems
                (instOrderId, instReqDetId, rowId, itemName, unitNo, height, width, orderId, orderNumber, status, created_at)
                VALUES (:ordId, :detId, :rowId, :itemName, :unitNo, :h, :w, :orderId, :orderNum, 'assigned', NOW())
                `,
                {
                    replacements: {
                        ordId: instOrderId,
                        detId: det.instReqDetId,
                        rowId: master.rowId,
                        itemName: master.itemName,
                        unitNo: master.unitIdDetail,
                        h: master.height,
                        w: master.width,
                        orderId: master.orderId,
                        orderNum: master.orderNumber,
                    },
                    transaction: trx,
                }
            );
            const itemRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            instOrderItemId = Number(itemRes[0].id);

            await sequelize2.query(
                `
                INSERT INTO IIT_Petra.instOrderDetails
                (instOrderId, masterRowId, unitCount, width, height, glassType, unitShapeId)
                VALUES (:ordId, :rowId, 1, :w, :h, NULL, :unitShapeId)
                `,
                {
                    replacements: {
                        ordId: instOrderId,
                        rowId: master.rowId,
                        w: master.width,
                        h: master.height,
                        unitShapeId: master.unitShapeId,
                    },
                    transaction: trx,
                }
            );
            const detailRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
            const instOrderDetailId = Number(detailRes[0].id);

            await sequelize2.query(
                `
                INSERT INTO IIT_Petra.instReqAssignments
                (instReqDetId, assignedEmpNo, teamId, assignedBy, assignedAt, progressStatus, progressPercent, instOrderId, instOrderDetailId)
                VALUES (:detId, :empNo, :teamId, :by, NOW(), 'Pending', 0, :ordId, :detailId)
                `,
                {
                    replacements: {
                        detId: det.instReqDetId,
                        empNo: reqUser.assignedEmpNo,
                        teamId,
                        by: reqUser.userId ?? null,
                        ordId: instOrderId,
                        detailId: instOrderDetailId,
                    },
                    transaction: trx,
                }
            );

            // No legacy instOrderSteps checklist for new self-assigns any
            // more -- component tracking (scanned against real Stock
            // allocation) is the only progress model going forward, same
            // cutover as instOrders.js's POST /create.
        }

        await sequelize2.query(
            `UPDATE IIT_Petra.instReqDet SET assignedTeamId = :teamId WHERE instReqDetId = :detId`,
            { replacements: { teamId, detId: det.instReqDetId }, transaction: trx }
        );

        await trx.commit();
        if (scheduleTarget) {
            await recordScheduleDay(scheduleTarget.instOrderId, scheduleTarget.teamId, today, reqUser.assignedEmpNo);
            notifyOrderUpdate();
        }
        return { success: true, httpStatus: 200, status: 'OK', instOrderItemId };
    } catch (err) {
        await trx.rollback();
        throw err;
    }
}

// Finds or creates a per-BARCODE instOrderItems row for a Stock item whose
// warehouse record never had a UNO -- deliberately scoped to exactly the
// one scanned barcode via instOrderItems.sourceBarcode, NOT every no-UNO
// item in the project, so self-assigning one such item never silently
// claims unrelated materials the worker never scanned. Not tied to any
// masterControl row (rowId is NULL throughout its instReqDet/
// instOrderItems/instOrderDetails rows), so it's located by
// (projectId, sourceBarcode) instead of the usual rowId lookup. Team
// ownership/reassignment mirrors the real-unit path in selfAssignUnit
// above (same-team is a no-op, different-team is a poach) for consistency.
async function selfAssignUnassignedItem({ teamId, wantProject, reqUser, barcode, stock }) {
    const projectRows = await sequelize.query(
        `SELECT projectId, projectNo FROM IIT_Petra.project WHERE projectNo LIKE :prefix`,
        { replacements: { prefix: `${wantProject}%` }, type: QueryTypes.SELECT }
    );
    const project = projectRows.find((p) => normalizeProjectNo(p.projectNo) === wantProject);
    if (!project) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Item not found in warehouse' };
    }

    const existingItem = await sequelize2.query(
        `
        SELECT iod.id AS instOrderItemId, iod.instReqDetId, iod.instOrderId, d.assignedTeamId
        FROM IIT_Petra.instOrderItems iod
        JOIN IIT_Petra.instReqDet d ON d.instReqDetId = iod.instReqDetId
        JOIN IIT_Petra.instReqMaster rm ON rm.instReqMasterId = d.instReqMasterId
        WHERE rm.projectId = :projectId AND iod.unitNo = :sentinel AND iod.sourceBarcode = :barcode
        LIMIT 1
        `,
        { replacements: { projectId: project.projectId, sentinel: UNASSIGNED_UNIT_NO, barcode: String(barcode) }, type: QueryTypes.SELECT }
    );

    if (existingItem.length) {
        const item = existingItem[0];
        if (item.assignedTeamId === teamId) {
            return {
                success: true,
                httpStatus: 200,
                status: 'ALREADY_YOURS',
                message: 'This item is already assigned to your team',
                instOrderItemId: item.instOrderItemId,
            };
        }

        const trx = await sequelize2.transaction();
        const today = toDateOnlyString(new Date());
        let scheduleTarget = null;
        try {
            const existingAssignment = await sequelize2.query(
                `SELECT id FROM IIT_Petra.instReqAssignments WHERE instReqDetId = :detId LIMIT 1`,
                { replacements: { detId: item.instReqDetId }, type: QueryTypes.SELECT, transaction: trx }
            );
            if (existingAssignment.length) {
                await sequelize2.query(
                    `UPDATE IIT_Petra.instReqAssignments SET teamId = :teamId, assignedEmpNo = :empNo, assignedBy = :by, assignedAt = NOW() WHERE id = :id`,
                    {
                        replacements: {
                            teamId,
                            empNo: reqUser.assignedEmpNo,
                            by: reqUser.userId ?? null,
                            id: existingAssignment[0].id,
                        },
                        transaction: trx,
                    }
                );
                // Safe to flip the order header directly here (unlike the
                // real-unit path above) -- a no-UNO item's instOrders
                // header is only ever created by this same function
                // (never by the web batch-create flow, which requires a
                // real masterControl rowId), so it's always exactly one
                // item per header. See PATCH /:id/schedule's own comment
                // for why this needs to stay in sync with
                // instReqAssignments.teamId at all. scheduled_date advances
                // to today too -- see findOrCreateSelfAssignOrder's comment
                // on why this was missing and what it broke.
                if (item.instOrderId) {
                    await sequelize2.query(
                        `UPDATE IIT_Petra.instOrders SET team_id = :teamId, assignedEmpNo = :empNo, scheduled_date = :today, updated_at = NOW() WHERE id = :instOrderId`,
                        {
                            replacements: { teamId, empNo: reqUser.assignedEmpNo, instOrderId: item.instOrderId, today },
                            transaction: trx,
                        }
                    );
                    scheduleTarget = { instOrderId: item.instOrderId, teamId };
                }
            }
            await sequelize2.query(
                `UPDATE IIT_Petra.instReqDet SET assignedTeamId = :teamId WHERE instReqDetId = :detId`,
                { replacements: { teamId, detId: item.instReqDetId }, transaction: trx }
            );
            await trx.commit();
            if (scheduleTarget) {
                await recordScheduleDay(scheduleTarget.instOrderId, scheduleTarget.teamId, today, reqUser.assignedEmpNo);
                notifyOrderUpdate();
            }
            return { success: true, httpStatus: 200, status: 'OK', instOrderItemId: item.instOrderItemId };
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    }

    const masterRows = await sequelize2.query(
        `SELECT instReqMasterId FROM IIT_Petra.instReqMaster WHERE projectId = :projectId LIMIT 1`,
        { replacements: { projectId: project.projectId }, type: QueryTypes.SELECT }
    );
    const instReqMasterId = masterRows[0]?.instReqMasterId;
    if (!instReqMasterId) {
        return {
            success: true,
            httpStatus: 200,
            status: 'NOT_REQUESTED',
            message: 'This project has no installation request set up yet',
        };
    }

    const trx = await sequelize2.transaction();
    const today = toDateOnlyString(new Date());
    try {
        // Reuse this team's existing self-assigned order for this project
        // if one already exists (order_number = 0 -- see the comment on
        // the split-order branch in selfAssignUnit() above) -- shared with
        // the real-unit path above via the same instReqMasterId+teamId
        // key, so a team's no-UNO self-assigns land in the same
        // consolidated order as their real-unit self-assigns in the same
        // project, instead of yet another separate header.
        const created = await findOrCreateSelfAssignOrder({
            instReqMasterId,
            teamId,
            empNo: reqUser.assignedEmpNo,
            note: 'Self-assigned (no recorded unit) from mobile scan',
            trx,
            today,
        });
        const instOrderId = created.instOrderId;

        await sequelize2.query(
            `INSERT INTO IIT_Petra.instReqDet (instReqMasterId, rowId, assignedTeamId) VALUES (:instReqMasterId, NULL, :teamId)`,
            { replacements: { instReqMasterId, teamId }, transaction: trx }
        );
        const detHeader = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
        const instReqDetId = detHeader[0].id;

        await sequelize2.query(
            `
            INSERT INTO IIT_Petra.instOrderItems
            (instOrderId, instReqDetId, rowId, itemName, unitNo, sourceBarcode, orderId, orderNumber, status, created_at)
            VALUES (:ordId, :detId, NULL, :itemName, :unitNo, :sourceBarcode, NULL, NULL, 'assigned', NOW())
            `,
            {
                replacements: {
                    ordId: instOrderId,
                    detId: instReqDetId,
                    // stock.Prodc comes from SQL Server as a proper Unicode
                    // string; itemName's existing Arabic values are all
                    // stored pre-mangled (see toLegacyArabicStorage) so
                    // fixArabic() restores them correctly on read.
                    itemName: stock.Prodc ? toLegacyArabicStorage(stock.Prodc) : 'Unassigned item',
                    unitNo: UNASSIGNED_UNIT_NO,
                    sourceBarcode: String(barcode),
                },
                transaction: trx,
            }
        );
        const itemRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
        const instOrderItemId = Number(itemRes[0].id);

        await sequelize2.query(
            `
            INSERT INTO IIT_Petra.instOrderDetails
            (instOrderId, masterRowId, unitCount, width, height, glassType, unitShapeId)
            VALUES (:ordId, NULL, NULL, NULL, NULL, NULL, NULL)
            `,
            { replacements: { ordId: instOrderId }, transaction: trx }
        );
        const detailRes = await sequelize2.query(`SELECT LAST_INSERT_ID() AS id`, { type: QueryTypes.SELECT, transaction: trx });
        const instOrderDetailId = Number(detailRes[0].id);

        await sequelize2.query(
            `
            INSERT INTO IIT_Petra.instReqAssignments
            (instReqDetId, assignedEmpNo, teamId, assignedBy, assignedAt, progressStatus, progressPercent, instOrderId, instOrderDetailId)
            VALUES (:detId, :empNo, :teamId, :by, NOW(), 'Pending', 0, :ordId, :detailId)
            `,
            {
                replacements: {
                    detId: instReqDetId,
                    empNo: reqUser.assignedEmpNo,
                    teamId,
                    by: reqUser.userId ?? null,
                    ordId: instOrderId,
                    detailId: instOrderDetailId,
                },
                transaction: trx,
            }
        );

        await trx.commit();
        await recordScheduleDay(instOrderId, teamId, today, reqUser.assignedEmpNo);
        notifyOrderUpdate();
        return { success: true, httpStatus: 200, status: 'OK', instOrderItemId };
    } catch (err) {
        await trx.rollback();
        throw err;
    }
}
