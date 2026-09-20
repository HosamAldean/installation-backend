// backend/services/instOrderComponents.js
// Shared logic for the component-based installation tracking model:
// validating a scanned barcode against the main warehouse (Stock/STOCKO in
// the `minstock` SQL Server DB) and persisting an install/issue record for
// it (InstOrderComponent, MySQL). Called from both the manager-facing web
// routes (instOrders.js) and the field-worker mobile routes (followUp.js);
// each applies its own permission/ownership gate before calling this.
//
// Stock.UNO is the real "this material is allocated to this unit" source
// -- confirmed via live data that the warehouse *shipment* log (`out`,
// used by the original version of this feature) is the wrong table for
// this: it accumulates every shipment ever made and the same UNO value
// gets recycled across unrelated projects/production runs over time,
// whereas Stock is current warehouse inventory allocated to a unit right
// now. Both still need the project+unit double-match guard, since UNO
// alone is reused across projects in Stock too.
import { sequelize, withSqlRetry } from '../config/db.js';
import { Op, QueryTypes } from 'sequelize';
import { InstOrderComponent } from '../models/InstOrderComponent.js';
import { InstOrderItems } from '../models/instOrderItems.js';
import { User } from '../models/User.js';

const normalizeProjectNo = (value) =>
    String(value || '')
        .replace(/\s+/g, '')
        .split('-')[0]
        .replace(/\.0$/, '')
        .trim()
        .toUpperCase();

// Unit numbers are NOT always plain integers -- confirmed live: many real
// units are labeled like "CW-14", "CW07", "8.1", not just "3". Worse, the
// SAME physical unit is recorded inconsistently across sources: ERP's own
// masterControl has unitIdDetail="CW07" paired with unitIdContract="CW-7"
// for the very same unit, and Stock.UNO itself holds both "CW10" and
// "CW-10" for what's the same unit. A naive parseInt() (the original
// implementation) returns NaN for any of these and silently drops the
// unit entirely -- confirmed live against real instOrderItems (units
// "CW-14"/"CW-22"/"CW-23" in project 4887 all showed 0 materials, when
// their barcodes really do exist in Stock, just under a differently-
// formatted UNO).
//
// This strips whitespace/hyphens and uppercases (fixing the CW10/CW-10
// case), then strips leading zeros from a numeric run directly after an
// alphabetic prefix (fixing CW07 -> CW7 to match CW-7 -> CW7) or at the
// very start of the string (preserving the original numeric-unit
// behavior, e.g. "03" -> "3"). Decimal points are deliberately left
// untouched -- "8.1"/"8.2" are real, distinct sub-unit numbers seen in
// live data, not a formatting inconsistency to collapse away.
export const normalizeUnitNo = (value) => {
    const cleaned = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    if (!cleaned) return '';
    return cleaned.replace(/^([A-Z]*)0+(\d)/, '$1$2');
};

// Sentinel unitNo for an instOrderItems row created for ONE specific Stock
// item whose warehouse record never had a UNO at all (confirmed live: ~25%
// of Stock rows in some projects have UNO = NULL -- a real gap in the
// source production system, not something a matching algorithm can resolve,
// since guessing the wrong unit would silently misattribute a material).
// Unlike a real unit, this row has no masterControl row behind it
// (rowId/masterRowId are NULL throughout its instReqDet/instOrderItems/
// instOrderDetails rows -- see selfAssignUnit.js) and is scoped to exactly
// the one barcode that was scanned (instOrderItems.sourceBarcode) rather
// than every no-UNO item in the project -- self-assigning one such item
// must not silently claim unrelated materials the worker never scanned.
export const UNASSIGNED_UNIT_NO = 'Unassigned';

// Project is resolved via instReqDet -> instReqMaster -> project, not via
// masterControl -- the masterControl path returns NULL for an Unassigned
// item (rowId is NULL there by design), while instReqDetId is always
// populated on every instOrderItems row. unitNo falls back to the raw
// iod.unitNo column (the sentinel above) whenever masterControl has
// nothing for this row; sourceBarcode identifies exactly which Stock item
// an Unassigned row was created for.
async function resolveUnit(instOrderItemId) {
    const rows = await sequelize.query(`
        SELECT iod.id AS instOrderItemId, j.projectNo, COALESCE(m.unitIdDetail, iod.unitNo) AS unitNo, iod.itemName, iod.status AS taskStatus, iod.sourceBarcode, iod.taskCompletedAt
        FROM IIT_Petra.instOrderItems iod
        JOIN IIT_Petra.instReqDet d ON d.instReqDetId = iod.instReqDetId
        JOIN IIT_Petra.instReqMaster rm ON rm.instReqMasterId = d.instReqMasterId
        JOIN IIT_Petra.project j ON j.projectId = rm.projectId
        LEFT JOIN IIT_Petra.masterControl m ON m.rowId = iod.rowId
        WHERE iod.id = :instOrderItemId
        LIMIT 1
    `, { replacements: { instOrderItemId }, type: QueryTypes.SELECT });
    return rows[0] || null;
}

// Every Stock row for a project (one row = one serialized/barcoded
// material), short-lived-cached by project prefix. GET /instOrders/
// assigned-components calls this once per unit -- with a project's units
// numbering in the dozens to hundreds, that reran this exact same
// Stock/STOCKO join query redundantly for every single one of them
// (confirmed live: 2000+ units meant 2000+ near-identical round trips to
// the remote minstock SQL Server, well past what its connection pool
// could sustain concurrently -- the endpoint 500'd outright, and even
// throttled to a modest concurrency it still took ~100s). Caching the raw
// per-project rows collapses that back down to one query per distinct
// project regardless of how many units request it. TTL is short (not
// request-scoped) since this project-level query has no per-request
// context to key on and near-real-time warehouse data is expected
// elsewhere in the app -- 10s is enough to collapse a single page load's
// fan-out without meaningfully staling a live status view.
const PROJECT_STOCK_CACHE_TTL_MS = 10_000;
const projectStockCache = new Map(); // wantProject -> { rows, expiresAt }

async function fetchProjectStockRows(wantProject) {
    const cached = projectStockCache.get(wantProject);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const result = await withSqlRetry('minstock', (pool) => pool.request()
        .input('projPrefix', `${wantProject}%`)
        .query(`
            SELECT s.orderNo, s.serialNo, s.Prodc, s.UNO, s.barcode, s.barcode1, o.projNo, o.ProdctionNO
            FROM Stock s
            JOIN STOCKO o ON o.orderNo = s.orderNo
            WHERE o.projNo LIKE @projPrefix
        `));
    projectStockCache.set(wantProject, { rows: result.recordset, expiresAt: Date.now() + PROJECT_STOCK_CACHE_TTL_MS });
    return result.recordset;
}

// Filters by project in SQL (via a LIKE prefix match, since STOCKO.projNo
// formatting varies too much for a clean exact-match), then does the final
// project+unit match in JS with normalizeUnitNo/normalizeProjectNo -- both
// UNO and projNo need fuzzy matching, not exact equality, so this can't be
// pushed further into the SQL WHERE clause.
async function fetchAllocatedMaterials(unit) {
    if (!unit?.projectNo || !unit?.unitNo) return [];
    const wantProject = normalizeProjectNo(unit.projectNo);
    if (!wantProject) return [];

    const rows = await fetchProjectStockRows(wantProject);

    // An Unassigned item is scoped to exactly the one barcode it was
    // self-assigned for -- not every no-UNO item in the project (a worker
    // scanning one such item must not silently claim unrelated materials
    // they never scanned).
    if (unit.unitNo === UNASSIGNED_UNIT_NO) {
        if (!unit.sourceBarcode) return [];
        return rows.filter((r) =>
            normalizeProjectNo(r.projNo) === wantProject && String(r.barcode) === String(unit.sourceBarcode)
        );
    }

    const wantUnit = normalizeUnitNo(unit.unitNo);
    if (!wantUnit) return [];
    return rows.filter((r) =>
        normalizeProjectNo(r.projNo) === wantProject && normalizeUnitNo(r.UNO) === wantUnit
    );
}

// Registers that a specific barcode was scanned, without yet confirming
// install/issue -- creates a 'Pending' row the FIRST time only (findOrCreate
// leaves an existing row untouched, whatever its status), so this row's
// createdAt is genuinely "when THIS barcode was first scanned", independent
// of any other material on the same unit. Required after per-unit timing
// (instOrderItems.taskStartedAt) showed a sibling material's elapsed time
// on a barcode's very first scan -- confirmed live on unit 07 B, whose 3
// materials share one instOrderItems row but must each track their own
// scan-to-confirm duration for reporting.
export async function registerMaterialScan({ instOrderItemId, barcode, productName, productionNo }) {
    const cleanBarcode = String(parseInt(barcode, 10));
    if (!cleanBarcode || cleanBarcode === 'NaN') return;
    const now = new Date();
    await InstOrderComponent.findOrCreate({
        where: { instOrderItemId, barcode: cleanBarcode },
        defaults: {
            instOrderItemId,
            barcode: cleanBarcode,
            productName: productName || null,
            productionNo: productionNo || null,
            status: 'Pending',
            createdAt: now,
            updatedAt: now,
        },
    });
}

// Pauses the timer on ONE scanned-but-not-yet-confirmed material, with a
// required reason -- excludes the paused interval from this material's own
// duration (see getUnitCompletionStats' per-material startedAt/completedAt/
// pausedSeconds/pausedAt, and the mobile clients' elapsed-time math). Only
// valid on a row that exists (i.e. already scanned via registerMaterialScan)
// and isn't already paused or resolved.
export async function pauseMaterialScan({ instOrderItemId, barcode, reason }) {
    if (!reason?.trim()) {
        return { success: false, httpStatus: 400, message: 'A reason is required to pause this item' };
    }
    const cleanBarcode = String(parseInt(barcode, 10));
    const component = await InstOrderComponent.findOne({ where: { instOrderItemId, barcode: cleanBarcode } });
    if (!component) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Scan this item before pausing it' };
    }
    if (component.status !== 'Pending') {
        return { success: true, httpStatus: 200, status: 'NOT_PENDING', message: 'Only an unconfirmed item can be paused' };
    }
    if (component.onHold) {
        return { success: true, httpStatus: 200, status: 'ALREADY_PAUSED', message: 'This item is already paused' };
    }
    await component.update({ onHold: true, holdReason: reason.trim(), pausedAt: new Date() });
    return { success: true, httpStatus: 200, status: 'OK', component };
}

// Resumes a paused material -- folds the just-finished pause interval into
// pausedSeconds (Node clock on both ends, so this is immune to the DB
// server's clock drift noted elsewhere in this file) and clears the active
// pause marker. holdReason is deliberately left in place as a record of why
// it was paused, not wiped on resume.
export async function resumeMaterialScan({ instOrderItemId, barcode }) {
    const cleanBarcode = String(parseInt(barcode, 10));
    const component = await InstOrderComponent.findOne({ where: { instOrderItemId, barcode: cleanBarcode } });
    if (!component) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Scan this item before resuming it' };
    }
    if (!component.onHold) {
        return { success: true, httpStatus: 200, status: 'NOT_PAUSED', message: 'This item is not paused' };
    }
    const pausedMs = Date.now() - new Date(component.pausedAt).getTime();
    await component.update({
        onHold: false,
        pausedAt: null,
        pausedSeconds: component.pausedSeconds + Math.max(0, Math.round(pausedMs / 1000)),
    });
    return { success: true, httpStatus: 200, status: 'OK', component };
}

async function resolveConfirmerNames(userIds) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return {};
    const users = await User.findAll({
        where: { userId: ids },
        attributes: ['userId', 'firstName', 'lastName', 'username'],
        raw: true,
    });
    return Object.fromEntries(
        users.map((u) => [u.userId, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username])
    );
}

// First-scan-wins for an item shared across more than one team: POST
// /instOrders/create deliberately allows the same instReqDetId to be
// assigned to several teams at once (see that route's own comment), each
// getting its OWN instOrderItems row -- so confirming a barcode installed
// under ONE team's row previously had no effect on the other team's row
// for the physically same material, and both could independently scan and
// confirm it, or a manager reviewing the "other" team's unit would still
// see it as Pending even though it was already done. Business rule this
// closes: the first team to scan a shared item finishes it for everyone --
// it should immediately read as Installed (attributed to whoever actually
// scanned it) on every sibling team's copy too, not just the scanning
// team's own.
//
// Deliberately does NOT overwrite a sibling that's already 'Issue' --
// propagation is one-directional (install -> siblings), and silently
// clearing a real reported problem because a different team's copy of the
// same physical material happened to get scanned as installed would hide
// it, not resolve it. A sibling's own Installed->Issue transition is
// unaffected (that still only ever happens via that team's own scan).
async function propagateInstalledToSiblingTeams({ instOrderItemId, barcode, productName, productionNo, userId, empNo }) {
    const self = await InstOrderItems.findByPk(instOrderItemId, { attributes: ['id', 'instReqDetId'] });
    if (!self?.instReqDetId) return;

    const siblings = await InstOrderItems.findAll({
        where: { instReqDetId: self.instReqDetId, id: { [Op.ne]: instOrderItemId } },
        attributes: ['id'],
    });
    if (!siblings.length) return;

    const now = new Date();
    for (const sibling of siblings) {
        const [component, created] = await InstOrderComponent.findOrCreate({
            where: { instOrderItemId: sibling.id, barcode: String(barcode) },
            defaults: {
                instOrderItemId: sibling.id,
                barcode: String(barcode),
                productName: productName || null,
                productionNo: productionNo || null,
                status: 'Installed',
                note: 'Confirmed installed via another team\'s scan (shared item)',
                confirmedByUserId: userId,
                confirmedByEmpNo: empNo || null,
                createdAt: now,
                updatedAt: now,
            },
        });
        if (!created && component.status !== 'Issue' && component.status !== 'Installed') {
            await component.update({
                status: 'Installed',
                note: component.note || 'Confirmed installed via another team\'s scan (shared item)',
                confirmedByUserId: userId,
                confirmedByEmpNo: empNo || null,
                updatedAt: now,
            });
        }
    }
}

// Records an install/issue action for one scanned material against one
// unit. `action` is 'install' or 'issue'; 'issue' requires a note (media
// is enforced by the route layer, which knows about multipart uploads).
// A material already recorded with the SAME status is a no-op duplicate;
// a different status (most commonly Installed -> Issue, confirmed as a
// real product decision -- a previously-installed item can later turn out
// to have a problem) updates the existing row in place rather than
// creating a second one, since each material can only be in one state.
export async function recordComponentAction({ instOrderItemId, barcode, action, note, mediaUrl, mediaType, userId, empNo }) {
    const cleanBarcode = parseInt(barcode, 10);
    if (!Number.isInteger(cleanBarcode)) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Barcode not found in warehouse' };
    }

    const unit = await resolveUnit(instOrderItemId);
    if (!unit) {
        return { success: false, httpStatus: 404, message: 'Unit not found' };
    }

    const stockRows = await withSqlRetry('minstock', (pool) => pool.request()
        .input('barcode', cleanBarcode)
        .query(`
            SELECT s.orderNo, s.serialNo, s.Prodc, s.UNO, s.barcode, o.projNo, o.ProdctionNO
            FROM Stock s
            JOIN STOCKO o ON o.orderNo = s.orderNo
            WHERE s.barcode = @barcode
        `));
    if (!stockRows.recordset.length) {
        return { success: true, httpStatus: 200, status: 'NOT_FOUND', message: 'Barcode not found in warehouse' };
    }
    const stock = stockRows.recordset[0];

    const projectMatch = unit.projectNo && stock.projNo
        && normalizeProjectNo(unit.projectNo) === normalizeProjectNo(stock.projNo);
    const unitMatch = unit.unitNo === UNASSIGNED_UNIT_NO
        ? !!unit.sourceBarcode && String(unit.sourceBarcode) === String(stock.barcode)
        : unit.unitNo != null && stock.UNO != null
            && normalizeUnitNo(unit.unitNo) !== ''
            && normalizeUnitNo(unit.unitNo) === normalizeUnitNo(stock.UNO);

    if (!projectMatch || !unitMatch) {
        return {
            success: true,
            httpStatus: 200,
            status: 'WRONG_UNIT',
            message: `Item ${stock.Prodc ?? ''} (unit ${stock.UNO ?? '?'}, project ${stock.projNo ?? '?'}) does not match this unit`,
            stock: { Prodc: stock.Prodc, ProdctionNO: stock.ProdctionNO, projNo: stock.projNo, UNO: stock.UNO },
        };
    }

    if (action === 'issue' && !note?.trim()) {
        return { success: false, httpStatus: 400, message: 'A note is required to report an issue' };
    }

    const newStatus = action === 'issue' ? 'Issue' : 'Installed';
    const [component, created] = await InstOrderComponent.findOrCreate({
        where: { instOrderItemId, barcode: String(cleanBarcode) },
        defaults: {
            instOrderItemId,
            barcode: String(cleanBarcode),
            productName: stock.Prodc || null,
            productionNo: stock.ProdctionNO || null,
            status: newStatus,
            note: note || null,
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || null,
            confirmedByUserId: userId,
            confirmedByEmpNo: empNo || null,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    });

    if (!created) {
        if (component.onHold) {
            return { success: true, httpStatus: 200, status: 'ON_HOLD', message: 'This item is paused -- resume it before confirming or reporting an issue' };
        }
        if (component.status === newStatus) {
            return {
                success: true,
                httpStatus: 200,
                status: newStatus === 'Issue' ? 'ALREADY_ISSUE' : 'ALREADY_CONFIRMED',
                message: newStatus === 'Issue'
                    ? 'An issue was already reported for this material'
                    : 'This material was already confirmed installed',
            };
        }
        await component.update({
            status: newStatus,
            note: note || component.note,
            mediaUrl: mediaUrl || component.mediaUrl,
            mediaType: mediaType || component.mediaType,
            confirmedByUserId: userId,
            confirmedByEmpNo: empNo || null,
            updatedAt: new Date(),
        });
        if (newStatus === 'Installed') {
            await propagateInstalledToSiblingTeams({
                instOrderItemId, barcode: cleanBarcode,
                productName: stock.Prodc, productionNo: stock.ProdctionNO,
                userId, empNo,
            });
        }
        return { success: true, httpStatus: 200, status: 'OK', component };
    }

    if (newStatus === 'Installed') {
        await propagateInstalledToSiblingTeams({
            instOrderItemId, barcode: cleanBarcode,
            productName: stock.Prodc, productionNo: stock.ProdctionNO,
            userId, empNo,
        });
    }
    return { success: true, httpStatus: 200, status: 'OK', component };
}

// Full picture for one unit: every material the warehouse has allocated
// to it (the real "expected" list) merged with whatever's been recorded
// against each, so the caller can render Pending/Installed/Issue per
// material and a completion percentage -- there's deliberately no fixed
// "total" independent of Stock, since no bill-of-materials table exists
// anywhere in the schema (confirmed earlier this session).
export async function getUnitCompletionStats(instOrderItemId) {
    const unit = await resolveUnit(instOrderItemId);
    const materials = unit ? await fetchAllocatedMaterials(unit) : [];

    const components = await InstOrderComponent.findAll({ where: { instOrderItemId }, raw: true });
    const componentsByBarcode = new Map(components.map((c) => [String(c.barcode), c]));
    const confirmerNames = await resolveConfirmerNames(components.map((c) => c.confirmedByUserId));

    // A component confirmed/flagged in the past can end up with a barcode
    // that no longer appears in Stock's current allocation for this unit
    // (Stock's own data changed since) -- without this, that row would
    // silently inflate installed/issue counts everywhere (this unit, its
    // order, its project, the global execution report) while being
    // completely invisible in `materials`, with no way to see or remove it.
    // Surfaced here using the snapshot taken at confirm-time instead.
    const stockBarcodes = new Set(materials.map((m) => String(m.barcode)));
    const orphanedComponents = components.filter((c) => !stockBarcodes.has(String(c.barcode)));

    const installed = components.filter((c) => c.status === 'Installed').length;
    const issue = components.filter((c) => c.status === 'Issue').length;
    const total = materials.length + orphanedComponents.length;
    const pending = Math.max(0, total - installed - issue);

    // Per-material timing, not per-unit: startedAt is this ONE barcode's own
    // first-scan moment (registerMaterialScan's createdAt), and completedAt
    // is when it was confirmed Installed -- each material on a multi-part
    // unit tracks its own duration independently, since sharing one
    // unit-level start time showed a sibling material's elapsed time on a
    // barcode's very first scan (confirmed live on unit 07 B).
    const stockMaterialRows = materials.map((m) => {
        const c = componentsByBarcode.get(String(m.barcode));
        return {
            componentId: c?.id || null,
            barcode: String(m.barcode),
            productName: m.Prodc,
            orderNo: m.orderNo ?? null,
            productionNo: m.ProdctionNO ?? null,
            barcode1: m.barcode1 ?? null,
            status: c?.status || 'Pending',
            note: c?.note || null,
            mediaUrl: c?.mediaUrl || null,
            mediaType: c?.mediaType || null,
            confirmedByName: c ? confirmerNames[c.confirmedByUserId] || null : null,
            updatedAt: c?.updatedAt || c?.createdAt || null,
            startedAt: c?.createdAt || null,
            completedAt: c?.status === 'Installed' ? (c?.updatedAt || null) : null,
            onHold: c?.onHold || false,
            holdReason: c?.holdReason || null,
            pausedAt: c?.pausedAt || null,
            pausedSeconds: c?.pausedSeconds || 0,
        };
    });
    const orphanedRows = orphanedComponents.map((c) => ({
        componentId: c.id,
        barcode: String(c.barcode),
        productName: c.productName,
        orderNo: null,
        productionNo: c.productionNo ?? null,
        barcode1: null,
        status: c.status,
        note: c.note || null,
        mediaUrl: c.mediaUrl || null,
        mediaType: c.mediaType || null,
        confirmedByName: confirmerNames[c.confirmedByUserId] || null,
        updatedAt: c.updatedAt || c.createdAt || null,
        startedAt: c.createdAt || null,
        completedAt: c.status === 'Installed' ? (c.updatedAt || null) : null,
        onHold: c.onHold || false,
        holdReason: c.holdReason || null,
        pausedAt: c.pausedAt || null,
        pausedSeconds: c.pausedSeconds || 0,
    }));

    return {
        total,
        installed,
        issue,
        pending,
        percentInstalled: total > 0 ? Math.round((installed / total) * 100) : 0,
        unitNo: unit?.unitNo ?? null,
        taskStatus: unit?.taskStatus ?? null,
        taskCompletedAt: unit?.taskCompletedAt ?? null,
        materials: [...stockMaterialRows, ...orphanedRows],
    };
}

// Explicit sign-off that this unit's component work is done: only allowed
// once every allocated material is Installed (no Pending, no open Issue) --
// a manual action rather than an automatic side-effect of hitting 100%, so
// there's a real recorded moment/actor for "this unit is finished" distinct
// from the running percentage. Writes directly to instOrderItems.status,
// which is a fixed MySQL ENUM('assigned','in_progress','done') -- 'done' is
// the closest existing value to "complete"; there's no schema change here,
// but note this reuses the same status field the (currently unused) step
// flow would also write to.
export async function markUnitComplete(instOrderItemId) {
    const stats = await getUnitCompletionStats(instOrderItemId);
    if (stats.total === 0) {
        return { success: true, httpStatus: 200, status: 'NO_MATERIALS', message: 'No materials allocated to this unit yet' };
    }
    if (stats.pending > 0 || stats.issue > 0) {
        return {
            success: true,
            httpStatus: 200,
            status: 'NOT_COMPLETE',
            message: 'All materials must be installed with no open issues before completing this task',
        };
    }
    // getUnitCompletionStats above already proved this unit exists (total >
    // 0 requires resolveUnit to have found it) -- MySQL's default
    // affectedRows semantics report 0 for a no-op UPDATE (value unchanged,
    // e.g. re-completing an already-done unit), which is NOT the same as
    // "row not found", so the result of update() isn't checked here.
    // Stamped with the Node app server's clock, not MySQL's NOW() -- see
    // the matching note on taskStartedAt in routes/followUp.js's
    // /scan-task route for why (IIT_Petra's DB server clock runs ~20min
    // ahead of the app server).
    await InstOrderItems.update(
        { status: 'done', taskCompletedAt: sequelize.literal(`COALESCE(taskCompletedAt, ${sequelize.escape(new Date())})`) },
        { where: { id: instOrderItemId } }
    );
    return { success: true, httpStatus: 200, status: 'OK' };
}
