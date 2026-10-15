// backend/services/matWhStoreTransfer.js
// Store-to-store transfer -- draft lines, send (transfer_out at the source),
// receive (transfer_in at the destination, possibly partial and repeated),
// cancel. Status flow and the two-step design are documented on
// MatWhStoreTransfer.js; routes live in routes/materialsWarehouseTransfer.js.
import { Op } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhStoreTransfer } from '../models/MatWhStoreTransfer.js';
import { MatWhStoreTransferLine } from '../models/MatWhStoreTransferLine.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';
import { MatWhItemStore } from '../models/MatWhItemStore.js';
import {
    postLedgerMovement, applyReceiptCost, getAvailableToReserve, normalizeColor, lockItems,
} from './matWhLedger.js';
import { findRequestKey, claimRequestKey } from './matWhRequestKeys.js';

const EPS = 0.000001;

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function parseQty(value, label = 'qty') {
    const qty = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(qty) || qty <= 0) {
        throw httpError(400, `${label} must be a number greater than 0`);
    }
    return qty;
}

function sameGranularity(a, b) {
    return a.itemId === b.itemId
        && (normalizeColor(a.color ?? null) ?? null) === (normalizeColor(b.color ?? null) ?? null)
        && (a.lengthMm ?? null) === (b.lengthMm ?? null);
}

async function nextTransferNo(transaction) {
    const prefix = `TR-${new Date().getFullYear()}-`;
    const last = await MatWhStoreTransfer.findOne({
        where: { transferNo: { [Op.like]: `${prefix}%` } },
        order: [['transferNo', 'DESC']],
        transaction,
    });
    const lastSeq = last ? Number(last.transferNo.slice(prefix.length)) || 0 : 0;
    return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;
}

export async function loadTransfer(id, expectedStatuses) {
    const transfer = await MatWhStoreTransfer.findByPk(id);
    if (!transfer) throw httpError(404, 'Transfer not found');
    if (expectedStatuses && !expectedStatuses.includes(transfer.status)) {
        throw httpError(409, `Not allowed while the transfer is '${transfer.status}'`);
    }
    return transfer;
}

// Re-reads the transfer with a row lock inside `t` and re-checks its status,
// so two concurrent send/receive calls (double-click, a retried request, an
// offline-queue replay racing a live submit) serialize instead of both
// posting ledger rows off the same stale read.
async function lockTransfer(id, expectedStatuses, t) {
    const transfer = await MatWhStoreTransfer.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!transfer) throw httpError(404, 'Transfer not found');
    if (!expectedStatuses.includes(transfer.status)) {
        throw httpError(409, `Not allowed while the transfer is '${transfer.status}'`);
    }
    return transfer;
}

export async function createTransfer({ fromStoreId, toStoreId, notes, createdBy }) {
    if (!fromStoreId || !toStoreId) throw httpError(400, 'fromStoreId and toStoreId are required');
    if (Number(fromStoreId) === Number(toStoreId)) throw httpError(400, 'A store cannot transfer to itself');
    const stores = await MatWhStore.findAll({ where: { id: [fromStoreId, toStoreId], isActive: true } });
    if (stores.length !== 2) throw httpError(400, 'Both stores must exist and be active');

    const t = await sequelizeUtf8.transaction();
    try {
        const transfer = await MatWhStoreTransfer.create({
            transferNo: await nextTransferNo(t),
            fromStoreId: Number(fromStoreId), toStoreId: Number(toStoreId),
            notes: notes || null, createdBy: createdBy ?? null, status: 'draft',
        }, { transaction: t });
        await t.commit();
        return transfer;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

// Adding the same item/color/length twice just raises the existing line's
// qty -- one line per ledger granularity keeps the receive matching simple.
export async function addLine(transferId, { itemId, color, lengthMm, qty }) {
    await loadTransfer(transferId, ['draft']);
    const item = await MatWhItem.findByPk(itemId);
    if (!item) throw httpError(404, 'Item not found');
    const wanted = {
        itemId: item.id,
        color: normalizeColor(color || null) ?? null,
        lengthMm: lengthMm != null && lengthMm !== '' ? Number(lengthMm) : null,
    };
    const amount = parseQty(qty);
    const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transferId } });
    const existing = lines.find((l) => sameGranularity(l, wanted));
    if (existing) return existing.update({ qtySent: existing.qtySent + amount });
    return MatWhStoreTransferLine.create({ storeTransferId: transferId, ...wanted, qtySent: amount });
}

export async function updateLine(transferId, lineId, qty) {
    await loadTransfer(transferId, ['draft']);
    const line = await MatWhStoreTransferLine.findOne({ where: { id: lineId, storeTransferId: transferId } });
    if (!line) throw httpError(404, 'Line not found');
    return line.update({ qtySent: parseQty(qty) });
}

export async function removeLine(transferId, lineId) {
    await loadTransfer(transferId, ['draft']);
    const removed = await MatWhStoreTransferLine.destroy({ where: { id: lineId, storeTransferId: transferId } });
    if (!removed) throw httpError(404, 'Line not found');
}

export async function cancelTransfer(transferId) {
    const transfer = await loadTransfer(transferId, ['draft']);
    return transfer.update({ status: 'cancelled' });
}

// Validates every line against the source store's available-to-reserve
// (so stock already reserved for a project can't be moved away), then
// posts one transfer_out per line in a single transaction. Several lines
// of the same item/color/length can't exist (addLine merges them), so a
// per-line check is a per-pool check.
export async function sendTransfer(transferId, sentBy) {
    const transfer = await loadTransfer(transferId, ['draft']);
    const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transferId } });
    if (lines.length === 0) throw httpError(400, 'Add at least one item before sending');

    const t = await sequelizeUtf8.transaction();
    try {
        // Transfer, then its items (see lockItems), before any read: the
        // availability check below runs under the same item locks that
        // reservation confirms take, so the two can't both hand out the
        // same free stock.
        await lockTransfer(transfer.id, ['draft'], t);
        await lockItems(lines.map((l) => l.itemId), t);

        // Same-pool lines share one available figure, so it's checked
        // per pool against the pool's total being sent.
        const pools = new Map();
        for (const line of lines) {
            const key = `${line.itemId}|${line.color ?? ''}|${line.lengthMm ?? ''}`;
            const pool = pools.get(key) || { itemId: line.itemId, color: line.color, lengthMm: line.lengthMm, qty: 0, lineIds: [] };
            pool.qty += Number(line.qtySent);
            pool.lineIds.push(line.id);
            pools.set(key, pool);
        }
        const short = [];
        for (const pool of pools.values()) {
            const available = await getAvailableToReserve(transfer.fromStoreId, pool.itemId, pool.color, pool.lengthMm, undefined, t);
            if (pool.qty > available + EPS) {
                for (const lineId of pool.lineIds) short.push({ lineId, itemId: pool.itemId, available, requested: pool.qty });
            }
        }
        if (short.length) {
            const err = httpError(409, `${short.length} line(s) exceed the stock available in the source store`);
            err.details = short;
            throw err;
        }

        const costs = await MatWhItemCost.findAll({
            where: { storeId: transfer.fromStoreId, itemId: [...new Set(lines.map((l) => l.itemId))] },
            transaction: t,
        });
        const costByItem = new Map(costs.map((c) => [c.itemId, c.currentCost]));

        for (const line of lines) {
            const unitCost = costByItem.get(line.itemId) ?? null;
            const entry = await postLedgerMovement({
                storeId: transfer.fromStoreId, itemId: line.itemId,
                qty: line.qtySent, direction: 'out', docType: 'transfer_out',
                refType: 'store_transfer_line', refId: line.id,
                unitCost, performedBy: sentBy, color: line.color, lengthMm: line.lengthMm,
            }, t);
            await line.update({ unitCost, outLedgerEntryId: entry.id }, { transaction: t });
        }
        await transfer.update({ status: 'sent', sentBy: sentBy ?? null, sentAt: new Date() }, { transaction: t });
        await t.commit();
        return transfer;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

// Resolves a scanned code: a variant barcode gives an exact
// item+color+length, an item barcode or item code gives a plain item.
export async function resolveBarcode(code) {
    const variant = await MatWhItemVariant.findOne({ where: { barcode: code, isActive: true } });
    if (variant) {
        return {
            itemId: variant.itemId,
            color: normalizeColor(variant.color ?? null) ?? null,
            lengthMm: variant.lengthMm ?? null,
            fromVariant: true,
        };
    }
    const item = await MatWhItem.findOne({ where: { [Op.or]: [{ barcode: code }, { itemCode: code }] } });
    if (!item) return null;
    return { itemId: item.id, color: null, lengthMm: null, fromVariant: false };
}

// Which transfer line a scanned code belongs to (null if none).
export async function lookupBarcode(transferId, code) {
    await loadTransfer(transferId);
    const resolved = await resolveBarcode(code);
    if (!resolved) throw httpError(404, 'Barcode not recognized');
    const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transferId } });
    return { line: lines.find((l) => sameGranularity(l, resolved)) ?? null, resolved };
}

// Same rule as the issue / goods-receipt barcode gate: an item that has
// variants must be confirmed by scanning the variant's own barcode; a
// barcode, when given, must match the line exactly.
async function assertBarcodeMatches(line, barcode, variantItemIds) {
    const code = String(barcode || '').trim();
    if (!code) {
        if (variantItemIds.has(line.itemId)) {
            throw httpError(400, 'Scan the item barcode to confirm what arrived');
        }
        return;
    }
    const resolved = await resolveBarcode(code);
    if (!resolved) throw httpError(404, `Barcode ${code} not recognized`);
    if (!sameGranularity(line, resolved)) {
        throw httpError(409, `Barcode ${code} does not match this line (different item, color or length)`);
    }
}

// Once stock lands in the destination store, that store must count as one
// the item "lives in" (MatWhItemStore.js) -- otherwise a reservation from
// it is rejected for an item whose known stores don't include it. Only for
// items that already have known stores: an item with none is store-
// flexible (any store accepted), and a first link would wrongly narrow it
// to this one store.
async function linkItemsToStore(itemIds, storeId, transaction) {
    if (!itemIds.length) return;
    const links = await MatWhItemStore.findAll({ where: { itemId: itemIds }, attributes: ['itemId', 'storeId'], transaction });
    const linkedItems = new Set(links.map((l) => l.itemId));
    const alreadyHere = new Set(links.filter((l) => l.storeId === storeId).map((l) => l.itemId));
    for (const itemId of itemIds) {
        if (!linkedItems.has(itemId) || alreadyHere.has(itemId)) continue;
        await MatWhItemStore.create({ itemId, storeId }, { transaction });
    }
}

// receipts: [{ lineId, qty, barcode }]. Each qty is capped at what's still
// outstanding on its line; posts transfer_in at the destination and carries
// the snapshotted cost into the destination store's cost.
// requestKey (optional): the phone's per-tap key (see
// services/matWhRequestKeys.js) -- a replay of an already-applied receive
// returns the transfer as it is now instead of receiving again.
export async function receiveLines(transferId, receipts, receivedBy, requestKey = null) {
    if (await findRequestKey(requestKey)) return MatWhStoreTransfer.findByPk(transferId);
    const transfer = await loadTransfer(transferId, ['sent', 'partially_received']);
    if (!Array.isArray(receipts) || receipts.length === 0) throw httpError(400, 'Nothing to receive');

    const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transferId } });
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const variantRows = await MatWhItemVariant.findAll({
        attributes: ['itemId'], where: { itemId: [...new Set(lines.map((l) => l.itemId))], isActive: true }, raw: true,
    });
    const variantItemIds = new Set(variantRows.map((v) => v.itemId));

    const planned = new Map();
    for (const r of receipts) {
        const line = lineById.get(Number(r.lineId));
        if (!line) throw httpError(404, `Line ${r.lineId} is not on this transfer`);
        const qty = parseQty(r.qty, 'Received qty');
        const outstanding = line.qtySent - line.qtyReceived - (planned.get(line.id) || 0);
        if (qty > outstanding + EPS) {
            throw httpError(409, `Only ${outstanding} still outstanding on this line -- cannot receive ${qty}`);
        }
        await assertBarcodeMatches(line, r.barcode, variantItemIds);
        planned.set(line.id, (planned.get(line.id) || 0) + qty);
    }

    const t = await sequelizeUtf8.transaction();
    try {
        // Lock whatever the status, so a replay racing the original (which
        // may have just completed the transfer) reaches the key check and
        // answers "done" instead of failing on 'received'.
        const locked = await lockTransfer(transfer.id, ['sent', 'partially_received', 'received'], t);
        if (!(await claimRequestKey(requestKey, { action: 'transfer_receive', refId: transfer.id, userId: receivedBy }, t))) {
            await t.rollback();
            return MatWhStoreTransfer.findByPk(transferId);
        }
        if (locked.status === 'received') throw httpError(409, "Not allowed while the transfer is 'received'");
        // Fresh qtyReceived under the lock -- the check above ran on a read
        // another receive may have overtaken since.
        const fresh = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transferId }, transaction: t });
        for (const l of fresh) lineById.set(l.id, l);
        lines.splice(0, lines.length, ...fresh);
        for (const [lineId, qty] of planned) {
            const line = lineById.get(lineId);
            const outstanding = line.qtySent - line.qtyReceived;
            if (qty > outstanding + EPS) {
                throw httpError(409, `Only ${outstanding} still outstanding on this line -- cannot receive ${qty}`);
            }
            await postLedgerMovement({
                storeId: transfer.toStoreId, itemId: line.itemId,
                qty, direction: 'in', docType: 'transfer_in',
                refType: 'store_transfer_line', refId: line.id,
                unitCost: line.unitCost, performedBy: receivedBy, color: line.color, lengthMm: line.lengthMm,
            }, t);
            if (line.unitCost != null) await applyReceiptCost(line.itemId, transfer.toStoreId, qty, line.unitCost, t);
            await line.update({ qtyReceived: line.qtyReceived + qty }, { transaction: t });
        }
        await linkItemsToStore([...new Set([...planned.keys()].map((id) => lineById.get(id).itemId))], transfer.toStoreId, t);
        const fullyReceived = lines.every((l) => l.qtySent - l.qtyReceived <= EPS);
        await transfer.update({
            status: fullyReceived ? 'received' : 'partially_received',
            receivedBy: receivedBy ?? null, lastReceivedAt: new Date(),
        }, { transaction: t });
        await t.commit();
        return transfer;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}
