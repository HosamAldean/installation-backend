// backend/services/matWhWriteoff.js
// Material Write-off: WM 10-41 (request, approve/reject) + WM 10-42
// (report, the actual destruction event + committee/management sign-off).
// See MatWhWriteoffRequest.js / MatWhWriteoffReport.js for the full status
// flow and why the ledger only posts at the report stage, not the request.
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhWriteoffRequest } from '../models/MatWhWriteoffRequest.js';
import { MatWhWriteoffRequestItem } from '../models/MatWhWriteoffRequestItem.js';
import { MatWhWriteoffReport } from '../models/MatWhWriteoffReport.js';
import { MatWhWriteoffReportItem } from '../models/MatWhWriteoffReportItem.js';
import { postLedgerMovement, getPhysicalBalance, normalizeColor, lockRow, lockItems } from './matWhLedger.js';

const EPS = 0.000001;

export async function createWriteoffRequest({ requestNo, storeId, projectId, projectNo, projectName, reason, requestedBy }) {
    return MatWhWriteoffRequest.create({
        requestNo, storeId,
        projectId: projectId ?? null, projectNo: projectNo ?? null, projectName: projectName ?? null,
        reason, requestDate: new Date(),
        status: 'draft', requestedBy: requestedBy ?? null,
    });
}

export async function submitWriteoffRequest(requestId) {
    const request = await MatWhWriteoffRequest.findByPk(requestId);
    if (!request) {
        const err = new Error('Write-off request not found');
        err.status = 404;
        throw err;
    }
    if (request.status !== 'draft') {
        const err = new Error(`Cannot submit a request in status '${request.status}'`);
        err.status = 409;
        throw err;
    }
    const itemCount = await MatWhWriteoffRequestItem.count({ where: { writeoffRequestId: requestId } });
    if (itemCount === 0) {
        const err = new Error('Add at least one item before submitting');
        err.status = 400;
        throw err;
    }
    await request.update({ status: 'submitted' });
    return request;
}

// Upper management's decision on the request itself -- not yet whether
// anything was destroyed, just whether a write-off may proceed at all.
export async function decideWriteoffRequest(requestId, decision, decidedBy, notes) {
    if (!['approved', 'rejected'].includes(decision)) {
        const err = new Error("decision must be 'approved' or 'rejected'");
        err.status = 400;
        throw err;
    }
    const request = await MatWhWriteoffRequest.findByPk(requestId);
    if (!request) {
        const err = new Error('Write-off request not found');
        err.status = 404;
        throw err;
    }
    if (request.status !== 'submitted') {
        const err = new Error(`Cannot decide a request in status '${request.status}'`);
        err.status = 409;
        throw err;
    }
    await request.update({
        status: decision, decidedBy, decidedDate: new Date(),
        decisionNotes: notes ?? null,
    });
    return request;
}

// WM 10-42: files the destruction report against an approved request and
// posts the real ledger movement for every line, all in one transaction --
// this is the actual physical-stock event (see MatWhWriteoffReport.js).
// One report per request (the model's own unique index on
// writeoffRequestId is the real guard; the status check here just gives a
// clean error before hitting it).
function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// Every destroyed qty must be > 0 and within what was approved (approval is
// per request, so a line's approved qty is its qtyRequested), and the total
// destroyed per item/color/length can't exceed the store's physical balance
// -- otherwise the writeoff posting drives stock negative.
async function assertDestroyedQtys(request, items, requestItemById, transaction) {
    const perRequestItem = new Map();
    for (const { writeoffRequestItemId, qtyDestroyed } of items) {
        const requestItem = requestItemById.get(writeoffRequestItemId);
        if (!requestItem) throw badRequest(`Request item ${writeoffRequestItemId} does not belong to this request`);
        const qty = Number(qtyDestroyed);
        if (!Number.isFinite(qty) || qty <= 0) throw badRequest('Each destroyed qty must be a number greater than 0');
        perRequestItem.set(requestItem.id, (perRequestItem.get(requestItem.id) || 0) + qty);
    }
    const perPool = new Map();
    for (const [requestItemId, qty] of perRequestItem) {
        const ri = requestItemById.get(requestItemId);
        if (qty > ri.qtyRequested + EPS) {
            throw badRequest(`Destroyed qty ${qty} exceeds the approved qty ${ri.qtyRequested} for item ${ri.itemId}`);
        }
        const color = normalizeColor(ri.color ?? null) ?? null;
        const lengthMm = ri.lengthMm ?? null;
        const key = `${ri.itemId}|${color}|${lengthMm}`;
        const pool = perPool.get(key) || { itemId: ri.itemId, color, lengthMm, qty: 0 };
        pool.qty += qty;
        perPool.set(key, pool);
    }
    for (const pool of perPool.values()) {
        const physical = await getPhysicalBalance(request.storeId, pool.itemId, pool.color, pool.lengthMm, transaction);
        if (pool.qty > physical + EPS) {
            throw badRequest(`Item ${pool.itemId}: only ${physical} in stock at this store -- cannot destroy ${pool.qty}`);
        }
    }
}

export async function createWriteoffReport({ writeoffRequestId, reportNo, destroyedDate, items, createdBy }) {
    const request = await MatWhWriteoffRequest.findByPk(writeoffRequestId);
    if (!request) {
        const err = new Error('Write-off request not found');
        err.status = 404;
        throw err;
    }
    if (request.status !== 'approved') {
        const err = new Error(`Cannot file a report against a request in status '${request.status}'`);
        err.status = 409;
        throw err;
    }
    if (!items || items.length === 0) {
        const err = new Error('Add at least one destroyed item');
        err.status = 400;
        throw err;
    }

    const requestItems = await MatWhWriteoffRequestItem.findAll({ where: { writeoffRequestId } });
    const requestItemById = new Map(requestItems.map((ri) => [ri.id, ri]));

    const t = await sequelizeUtf8.transaction();
    try {
        const locked = await lockRow(MatWhWriteoffRequest, request.id, t);
        if (locked.status !== 'approved') {
            const err = new Error(`Cannot file a report against a request in status '${locked.status}'`);
            err.status = 409;
            throw err;
        }
        // Item locks (see lockItems), then the stock check inside t, so a
        // concurrent movement of the same items can't slip between the
        // check and the posting.
        await lockItems(requestItems.map((ri) => ri.itemId), t);
        await assertDestroyedQtys(request, items, requestItemById, t);
        const report = await MatWhWriteoffReport.create({
            writeoffRequestId, reportNo, destroyedDate,
            createdBy: createdBy ?? null, status: 'recorded',
        }, { transaction: t });

        for (const { writeoffRequestItemId, qtyDestroyed } of items) {
            const requestItem = requestItemById.get(writeoffRequestItemId);
            if (!requestItem) {
                const err = new Error(`Request item ${writeoffRequestItemId} does not belong to this request`);
                err.status = 400;
                throw err;
            }
            const reportItem = await MatWhWriteoffReportItem.create({
                writeoffReportId: report.id, writeoffRequestItemId,
                itemId: requestItem.itemId, storeId: request.storeId,
                color: requestItem.color, lengthMm: requestItem.lengthMm,
                qtyDestroyed,
            }, { transaction: t });
            const ledgerRow = await postLedgerMovement({
                storeId: request.storeId, itemId: requestItem.itemId, projectId: request.projectId,
                qty: qtyDestroyed, direction: 'out', docType: 'writeoff',
                refType: 'writeoff_report_item', refId: reportItem.id,
                performedBy: createdBy,
                color: requestItem.color, lengthMm: requestItem.lengthMm,
            }, t);
            await reportItem.update({ ledgerEntryId: ledgerRow.id }, { transaction: t });
        }

        await request.update({ status: 'reported' }, { transaction: t });
        await t.commit();
        return report;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

export async function signWriteoffReportCommittee(reportId, committeeMemberBy, notes) {
    const report = await MatWhWriteoffReport.findByPk(reportId);
    if (!report) {
        const err = new Error('Write-off report not found');
        err.status = 404;
        throw err;
    }
    if (report.status !== 'recorded') {
        const err = new Error(`Cannot sign a report in status '${report.status}'`);
        err.status = 409;
        throw err;
    }
    await report.update({
        status: 'committee_signed', committeeMemberBy,
        committeeSignedDate: new Date(), committeeNotes: notes ?? null,
    });
    return report;
}

export async function acknowledgeWriteoffReport(reportId, ackBy) {
    const report = await MatWhWriteoffReport.findByPk(reportId);
    if (!report) {
        const err = new Error('Write-off report not found');
        err.status = 404;
        throw err;
    }
    if (report.status !== 'committee_signed') {
        const err = new Error(`Cannot acknowledge a report in status '${report.status}'`);
        err.status = 409;
        throw err;
    }
    await report.update({
        status: 'acknowledged', upperManagementAckBy: ackBy, upperManagementAckDate: new Date(),
    });
    return report;
}
