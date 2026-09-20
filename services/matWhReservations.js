// backend/services/matWhReservations.js
// Reservation workflow: a technician builds the request (WM 10-21, header
// 'draft', lines freely added/removed), then submits it -- from that point
// each line routes to its own real store (MatWhItemStore.js) and is
// confirmed or rejected independently by that store, not as one whole-
// reservation approval by a single supervisor. "Confirm all"/"reject all"
// still exist as convenience actions that process every still-pending line
// at once, per direct request ("can confirm by item or all"). Rejecting a
// line records a reason (WM 10-21's rejection field) and never touches
// stock. Confirming reserves whatever's available and raises an auto-
// generated purchase order for any shortfall. Reservations never post to
// matWhStockLedger (see MatWhReservationItem.js) -- only the shortfall's
// future goods receipt will, same as any other purchase order, and only
// issuing a confirmed line (WM 10-22) actually moves stock.
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhReservationHeader } from '../models/MatWhReservationHeader.js';
import { MatWhReservationItem } from '../models/MatWhReservationItem.js';
import { MatWhPurchaseOrder } from '../models/MatWhPurchaseOrder.js';
import { MatWhPurchaseOrderItem } from '../models/MatWhPurchaseOrderItem.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { getAvailableToReserve, postLedgerMovement } from './matWhLedger.js';

// Derives the header's overall status from its lines -- but only once no
// line is still 'pending' (the caller's job: while any line remains
// undecided the header stays 'submitted', a plain state set once at
// submit time, not recomputed here -- 'pending' can't be told apart from
// "just submitted, nothing decided yet" using line data alone, since
// submitting doesn't touch any line). A 'released' or 'rejected' line is
// ignored once something else has actually happened (issued/held) --
// 'rejected' only wins outright when EVERY line ended up rejected;
// 'released' wins when every remaining line is released (a mix of
// released+rejected with nothing ever confirmed reads as 'rejected' --
// nothing useful was ever actually reserved).
export function computeHeaderStatus(lines) {
    if (lines.length === 0) return 'draft';
    const active = lines.filter((l) => l.status !== 'released' && l.status !== 'rejected');
    if (active.length === 0) {
        return lines.every((l) => l.status === 'rejected') ? 'rejected' : 'released';
    }
    if (active.every((l) => l.status === 'issued')) return 'issued';
    return 'confirmed';
}

// Auto-PO numbers are still generated server-side -- there's no form field
// for one, an auto-generated PO is raised by confirmReservation itself, not
// typed in by anyone. Insert with a collision-proof placeholder, then
// rename to the friendly, id-based form in the same transaction -- avoids a
// race between "check next number" and "insert."
async function createWithGeneratedNo(model, field, prefix, values, transaction) {
    const placeholder = `TMP-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = await model.create({ ...values, [field]: placeholder }, { transaction });
    const finalNo = `${prefix}-${String(row.id).padStart(6, '0')}`;
    await row.update({ [field]: finalNo }, { transaction });
    return row;
}

// reservationNo is user-entered (per explicit request), not generated --
// the route validates it's present before calling this; the model's own
// `unique: true` still catches a real collision.
export async function createReservationHeader({ reservationNo, projectId, projectNo, projectName, projectManager, requestedByName, reservedUntilDate, notes, createdBy }) {
    return MatWhReservationHeader.create({
        reservationNo,
        projectId, projectNo: projectNo ?? null, projectName: projectName ?? null,
        projectManager: projectManager ?? null, requestedByName: requestedByName ?? null,
        reservationDate: new Date(),
        reservedUntilDate: reservedUntilDate ?? null, notes: notes ?? null,
        status: 'draft', createdBy: createdBy ?? null,
    });
}

// A reservation's item lines are locked in once sent to the stores that
// actually hold each item -- draft -> submitted is a one-way door, same as
// draft -> confirmed used to be, just renamed to reflect what's really
// happening (WM 10-21's "sent to store", not yet anyone's decision).
export async function submitReservation(headerId) {
    const header = await MatWhReservationHeader.findByPk(headerId);
    if (!header) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
    }
    if (header.status !== 'draft') {
        const err = new Error(`Cannot submit a reservation in status '${header.status}'`);
        err.status = 409;
        throw err;
    }
    const lineCount = await MatWhReservationItem.count({ where: { reservationHeaderId: headerId } });
    if (lineCount === 0) {
        const err = new Error('Add at least one item before submitting');
        err.status = 400;
        throw err;
    }
    await header.update({ status: 'submitted' });
    return header;
}

// Shared earmark logic for exactly one line -- always its own auto-PO for
// any shortfall (a genuinely isolated decision, unlike the bulk grouping
// below, which only makes sense when several lines are decided in the
// same action). Caller supplies the transaction.
async function confirmOneLine(line, header, confirmedBy, t) {
    const available = await getAvailableToReserve(line.storeId, line.itemId);
    const qtyReserved = Math.max(0, Math.min(line.qtyRequested, available));
    const qtyShortfall = line.qtyRequested - qtyReserved;
    const status = qtyShortfall > 0 ? 'partially_confirmed' : 'confirmed';

    await line.update({
        qtyReserved, qtyShortfall, status,
        reservedBy: confirmedBy, reservedDate: new Date(),
    }, { transaction: t });

    if (qtyShortfall > 0) {
        const item = await MatWhItem.findByPk(line.itemId, { transaction: t });
        const po = await createWithGeneratedNo(MatWhPurchaseOrder, 'poNo', 'PO-AUTO', {
            vendorId: item?.preferredVendorId ?? null, destinationStoreId: line.storeId,
            isAutoGenerated: true, createdBy: confirmedBy, netAmt: 0,
            sourceReservationId: header.id,
            projectId: header.projectId, projectNo: header.projectNo, projectName: header.projectName,
            notes: `Auto-generated from reservation ${header.reservationNo} (shortfall on confirm)`,
            // Starts the storekeeper->manager->purchasing review chain --
            // see MatWhPurchaseOrder.js's own comment for why this is a
            // separate track from `status`.
            internalApprovalStatus: 'pending_storekeeper',
        }, t);
        const poItem = await MatWhPurchaseOrderItem.create({
            purchaseOrderId: po.id, itemId: line.itemId,
            qtyOrdered: qtyShortfall, unitPrice: 0, lineAmt: 0,
            reservationItemId: line.id, neededByDate: line.itemNeededByDate,
        }, { transaction: t });
        await line.update({ purchaseOrderId: po.id, purchaseOrderItemId: poItem.id }, { transaction: t });
    }
}

// WM 10-21's per-store decision on exactly one line -- confirming reserves
// whatever's available on that line and raises its own shortfall PO if
// needed. Only reachable once the header's been submitted (each store
// reviews its own lines independently from then on, not gated by any
// other store's lines being decided yet).
export async function confirmReservationLine(lineId, confirmedBy) {
    const line = await MatWhReservationItem.findByPk(lineId);
    if (!line) {
        const err = new Error('Reservation line not found');
        err.status = 404;
        throw err;
    }
    if (line.status !== 'pending') {
        const err = new Error(`Cannot confirm a line in status '${line.status}'`);
        err.status = 409;
        throw err;
    }
    const header = await MatWhReservationHeader.findByPk(line.reservationHeaderId);
    if (header.status !== 'submitted') {
        const err = new Error(`Cannot confirm a line on a reservation in status '${header.status}'`);
        err.status = 409;
        throw err;
    }

    const t = await sequelizeUtf8.transaction();
    try {
        await confirmOneLine(line, header, confirmedBy, t);
        const siblings = await MatWhReservationItem.findAll({ where: { reservationHeaderId: header.id }, transaction: t });
        if (!siblings.some((l) => l.status === 'pending')) {
            await header.update({ status: computeHeaderStatus(siblings), confirmedBy, confirmedDate: new Date() }, { transaction: t });
        }
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }
    return { line: await MatWhReservationItem.findByPk(lineId), header: await MatWhReservationHeader.findByPk(header.id) };
}

// WM 10-21's per-store rejection of exactly one line, with a reason --
// never touches stock or raises a PO, the line simply stops being part of
// what's actively pursued.
export async function rejectReservationLine(lineId, rejectedBy, reason) {
    const line = await MatWhReservationItem.findByPk(lineId);
    if (!line) {
        const err = new Error('Reservation line not found');
        err.status = 404;
        throw err;
    }
    if (line.status !== 'pending') {
        const err = new Error(`Cannot reject a line in status '${line.status}'`);
        err.status = 409;
        throw err;
    }
    const header = await MatWhReservationHeader.findByPk(line.reservationHeaderId);
    if (header.status !== 'submitted') {
        const err = new Error(`Cannot reject a line on a reservation in status '${header.status}'`);
        err.status = 409;
        throw err;
    }
    if (!reason || !String(reason).trim()) {
        const err = new Error('A rejection reason is required');
        err.status = 400;
        throw err;
    }

    await line.update({
        status: 'rejected', rejectedBy, rejectedDate: new Date(), rejectionReason: String(reason).trim(),
    });
    const siblings = await MatWhReservationItem.findAll({ where: { reservationHeaderId: header.id } });
    if (!siblings.some((l) => l.status === 'pending')) {
        await header.update({ status: computeHeaderStatus(siblings) });
    }
    return { line: await MatWhReservationItem.findByPk(lineId), header: await MatWhReservationHeader.findByPk(header.id) };
}

// Bulk convenience: every still-pending line at once, grouping shortfalls
// by (vendor, destination store) so processing many lines in the same
// action doesn't spam one auto-PO per item -- this grouping only makes
// sense here, not on confirmReservationLine's genuinely isolated single
// decision. All-or-nothing per call -- if any line's write fails, nothing
// (including any PO already created earlier in this same call) is kept.
export async function confirmReservation(headerId, confirmedBy) {
    const header = await MatWhReservationHeader.findByPk(headerId);
    if (!header) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
    }
    if (header.status !== 'submitted') {
        const err = new Error(`Cannot confirm a reservation in status '${header.status}'`);
        err.status = 409;
        throw err;
    }

    const lines = (await MatWhReservationItem.findAll({ where: { reservationHeaderId: headerId } }))
        .filter((l) => l.status === 'pending');
    if (lines.length === 0) {
        const err = new Error('No pending items left to confirm');
        err.status = 400;
        throw err;
    }

    const t = await sequelizeUtf8.transaction();
    try {
        // Shortfalls grouped by (vendor, destination store) -- a null
        // vendor (item has no preferredVendorId) is its own group, one
        // draft PO per confirm action for someone to assign a vendor to
        // by hand, rather than one per unassigned item.
        const shortfallGroups = new Map(); // key -> { vendorId, storeId, lines: [{ reservationItem, item, qty }] }

        for (const line of lines) {
            const available = await getAvailableToReserve(line.storeId, line.itemId);
            const qtyReserved = Math.max(0, Math.min(line.qtyRequested, available));
            const qtyShortfall = line.qtyRequested - qtyReserved;
            const status = qtyShortfall > 0 ? 'partially_confirmed' : 'confirmed';

            await line.update({
                qtyReserved, qtyShortfall, status,
                reservedBy: confirmedBy, reservedDate: new Date(),
            }, { transaction: t });

            if (qtyShortfall > 0) {
                const item = await MatWhItem.findByPk(line.itemId, { transaction: t });
                const vendorId = item?.preferredVendorId ?? null;
                const key = `${vendorId ?? 'none'}::${line.storeId}`;
                if (!shortfallGroups.has(key)) {
                    shortfallGroups.set(key, { vendorId, storeId: line.storeId, lines: [] });
                }
                shortfallGroups.get(key).lines.push({ reservationItem: line, qty: qtyShortfall });
            }
        }

        for (const group of shortfallGroups.values()) {
            const po = await createWithGeneratedNo(MatWhPurchaseOrder, 'poNo', 'PO-AUTO', {
                vendorId: group.vendorId, destinationStoreId: group.storeId,
                isAutoGenerated: true, createdBy: confirmedBy,
                netAmt: 0,
                sourceReservationId: header.id,
                projectId: header.projectId,
                projectNo: header.projectNo,
                projectName: header.projectName,
                notes: `Auto-generated from reservation ${header.reservationNo} (shortfall on confirm)`,
                internalApprovalStatus: 'pending_storekeeper',
            }, t);

            for (const { reservationItem, qty } of group.lines) {
                const poItem = await MatWhPurchaseOrderItem.create({
                    purchaseOrderId: po.id, itemId: reservationItem.itemId,
                    qtyOrdered: qty, unitPrice: 0, lineAmt: 0,
                    reservationItemId: reservationItem.id,
                    neededByDate: reservationItem.itemNeededByDate,
                }, { transaction: t });
                await reservationItem.update({
                    purchaseOrderId: po.id, purchaseOrderItemId: poItem.id,
                }, { transaction: t });
            }
        }

        const allLines = await MatWhReservationItem.findAll({ where: { reservationHeaderId: headerId }, transaction: t });
        await header.update({
            status: computeHeaderStatus(allLines), confirmedBy, confirmedDate: new Date(),
        }, { transaction: t });
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }

    const finalLines = await MatWhReservationItem.findAll({ where: { reservationHeaderId: headerId } });
    return {
        header: await MatWhReservationHeader.findByPk(headerId),
        items: finalLines,
        purchaseOrdersCreated: new Set(finalLines.filter((l) => l.purchaseOrderId).map((l) => l.purchaseOrderId)).size,
    };
}

// Bulk convenience: rejects every still-pending line with one shared
// reason -- for when the whole remaining request is being turned down at
// once, not line by line.
export async function rejectReservation(headerId, rejectedBy, reason) {
    const header = await MatWhReservationHeader.findByPk(headerId);
    if (!header) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
    }
    if (header.status !== 'submitted') {
        const err = new Error(`Cannot reject a reservation in status '${header.status}'`);
        err.status = 409;
        throw err;
    }
    if (!reason || !String(reason).trim()) {
        const err = new Error('A rejection reason is required');
        err.status = 400;
        throw err;
    }

    const lines = (await MatWhReservationItem.findAll({ where: { reservationHeaderId: headerId } }))
        .filter((l) => l.status === 'pending');
    if (lines.length === 0) {
        const err = new Error('No pending items left to reject');
        err.status = 400;
        throw err;
    }

    const trimmedReason = String(reason).trim();
    for (const line of lines) {
        await line.update({
            status: 'rejected', rejectedBy, rejectedDate: new Date(), rejectionReason: trimmedReason,
        });
    }

    const allLines = await MatWhReservationItem.findAll({ where: { reservationHeaderId: headerId } });
    await header.update({ status: computeHeaderStatus(allLines) });

    return { header: await MatWhReservationHeader.findByPk(headerId), items: allLines };
}

// WM 10-22's storekeeper stage: the physical hand-over of one already-
// confirmed line's earmarked quantity. Deliberately per-line, not per-
// header -- items on the same reservation are realistically picked up at
// different times, and this is the one action in the whole reservation
// flow that actually moves stock (see MatWhStockLedger.js). Only the
// qtyReserved amount ever leaves; a line's own shortfall (covered by its
// auto-PO, if any) is a separate goods-receipt event later, not part of
// this line's issue.
export async function issueReservationLine(lineId, issuedBy, issuedBarcode) {
    const line = await MatWhReservationItem.findByPk(lineId);
    if (!line) {
        const err = new Error('Reservation line not found');
        err.status = 404;
        throw err;
    }
    if (!['confirmed', 'partially_confirmed'].includes(line.status)) {
        const err = new Error(`Cannot issue a line in status '${line.status}'`);
        err.status = 409;
        throw err;
    }
    if (!(line.qtyReserved > 0)) {
        const err = new Error('Nothing reserved on this line to issue');
        err.status = 409;
        throw err;
    }

    const header = await MatWhReservationHeader.findByPk(line.reservationHeaderId);

    const t = await sequelizeUtf8.transaction();
    try {
        await postLedgerMovement({
            storeId: line.storeId, itemId: line.itemId, projectId: header.projectId,
            qty: line.qtyReserved, direction: 'out', docType: 'issue',
            refType: 'reservation_item', refId: line.id,
            performedBy: issuedBy,
        }, t);

        await line.update({
            status: 'issued', issuedBy, issuedDate: new Date(),
            issuedBarcode: issuedBarcode || null,
        }, { transaction: t });

        const siblingLines = await MatWhReservationItem.findAll({
            where: { reservationHeaderId: header.id }, transaction: t,
        });
        if (!siblingLines.some((l) => l.status === 'pending')) {
            await header.update({ status: computeHeaderStatus(siblingLines) }, { transaction: t });
        }

        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }

    return { line: await MatWhReservationItem.findByPk(lineId), header: await MatWhReservationHeader.findByPk(header.id) };
}
