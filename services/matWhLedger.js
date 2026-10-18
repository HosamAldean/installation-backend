// backend/services/matWhLedger.js
// Shared helpers for the WH.3 unified stock ledger -- used by
// routes/materialsWarehouseOperations.js (reservations, external
// processing, manual movements) and routes/materialsWarehousePurchasing.js
// (goods receipt posts here too, per the Alpha Warehouse Analysis report
// §10: receipt makes stock usable immediately, independent of invoicing).
import { Op } from 'sequelize';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { MatWhReservationItem } from '../models/MatWhReservationItem.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';
import { MatWhItem } from '../models/MatWhItem.js';

// Lines that count against availability: confirmed in full, or confirmed
// for whatever was available with the rest covered by an auto-PO. A
// 'pending' line (still sitting in someone's draft reservation) does not
// hold stock yet -- only Confirm Reservation does that, same as the old
// flat model's 'active' status did.
const HELD_STATUSES = ['confirmed', 'partially_confirmed'];

// "MILL" is a real, user-selectable color (IIT_Petra.colorInfo, see
// add-matwh-colorinfo-mill-and-black.js) representing mill-finish/raw
// aluminum -- but physically it's the exact same untreated stock this
// ledger has always tracked as color: null. Never let "MILL" become a
// third, disconnected color bucket: every function below that takes a
// color runs it through this first, so a caller can pass either
// interchangeably and both land in the one real mill-finish pool. Any
// other string (a real paint color, or already null/undefined) passes
// through unchanged.
export function normalizeColor(color) {
    return color === 'MILL' ? null : color;
}

// Double-post guard for every action that checks something (a status, an
// already-received/returned total, "no movement yet") and then posts to
// this ledger: re-read the deciding row with a row lock as the FIRST
// statement of the transaction, then re-check against what it returns. A
// second concurrent call (double-click, retried request, offline-queue
// replay) waits on the lock and then sees the first one's committed
// result. It must come first: under REPEATABLE READ a plain read before
// it would pin an older snapshot for the rest of the transaction.
export async function lockRow(model, id, transaction) {
    return model.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
}

// Item-level lock for anything that hands out "available to reserve"
// (reservation confirm, substitute, fulfill-shortfall): two of those for
// the same item would otherwise both read the same free stock and both
// earmark it. Ascending id order so two multi-item callers can't deadlock;
// callers that also lock reservation lines take the item locks FIRST.
export async function lockItems(itemIds, transaction) {
    for (const id of [...new Set(itemIds.map(Number))].sort((a, b) => a - b)) {
        await lockRow(MatWhItem, id, transaction);
    }
}

// matWhStockLedger.color is always write-normalized (see
// postLedgerMovement) -- a mill-finish movement is NEVER stored there as
// the literal string 'MILL', only ever null, so a plain equality match on
// the normalized value is correct for ledger queries.
//
// MatWhReservationItem.color is deliberately NOT write-normalized -- a
// line where a technician explicitly picked "MILL" keeps that literal
// value stored, so it still displays as "MILL" on the reservation (the
// whole point of making it a real selectable color). That means an
// already-reserved/pending query for the mill-finish pool has to match
// EITHER a literal null (the original, pre-MILL convention -- e.g. every
// line auto-routed there by a painted-color shortfall) OR the literal
// string 'MILL' (a line where it was explicitly requested) -- both
// represent the exact same physical demand. Returns a where-clause
// fragment to merge in, not a bare value, for exactly that reason.
function reservationItemColorWhere(color) {
    if (color === undefined) return {};
    const normalized = normalizeColor(color);
    if (normalized === null) return { [Op.or]: [{ color: null }, { color: 'MILL' }] };
    return { color: normalized };
}

// Appends one ledger row. `transaction` is required for callers already
// inside one (goods receipt, external processing) -- pass undefined for a
// standalone call. `color` is optional -- omit it (or pass undefined) for
// a movement with no color dimension; pass an explicit value (including
// null, meaning mill-finish/raw) when the item genuinely has one. See
// MatWhStockLedger.js's own comment for why null and undefined mean
// different things here. `lengthMm` is optional too, same "omit to not
// record a length at all" idea, but simpler than color -- there's no
// length equivalent of "MILL" needing normalization, a plain pass-through.
export async function postLedgerMovement({
    storeId, itemId, projectId, qty, direction, docType, refType, refId,
    unitCost, performedBy, color, lengthMm,
}, transaction) {
    return MatWhStockLedger.create({
        storeId, itemId, projectId: projectId ?? null,
        qty, direction, docType, refType: refType ?? null, refId: refId ?? null,
        unitCost: unitCost ?? null,
        totalCost: unitCost != null ? unitCost * qty : null,
        movementDate: new Date(),
        performedBy: performedBy ?? null,
        color: normalizeColor(color) ?? null,
        lengthMm: lengthMm ?? null,
    }, { transaction });
}

// Physical on-hand balance for one store+item: sum(in) - sum(out) across
// the whole ledger. Does not account for reservations -- see
// getAvailableToReserve for the figure that actually matters when deciding
// whether a new reservation can be made.
//
// `color` is the backward-compatibility hinge for every function below
// that takes it: passed as `undefined` (the default -- simply not
// supplying the argument), the where-clause gets no color condition at
// all, so an existing caller that doesn't know about color sees EXACTLY
// today's pooled-across-all-colors total, unchanged. Passing an explicit
// color (including `null`, meaning "raw/mill-finish only") narrows the
// query to that one color specifically. Never pass `null` meaning
// "ignore color" -- that's what omitting the argument is for.
// `lengthMm` follows the same "omitted = pooled, explicit = narrowed"
// convention as `color` -- omit it entirely for today's exact behavior
// (every existing color-only caller is unaffected), pass a real number to
// scope the balance to that one length specifically.
// `transaction` (optional, every balance helper below): read inside the
// caller's transaction so its own uncommitted earmarks count, and -- after
// a lockItems -- so the read reflects whatever the lock waited for.
export async function getPhysicalBalance(storeId, itemId, color, lengthMm, transaction) {
    const where = { storeId, itemId };
    if (color !== undefined) where.color = normalizeColor(color);
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhStockLedger.findAll({ where, transaction });
    let balance = 0;
    for (const r of rows) balance += r.direction === 'in' ? r.qty : -r.qty;
    return balance;
}

// Available-to-reserve = physical balance - currently active reservations
// for the same store+item(+color)(+length). This is the figure
// feasibility checks and new reservations actually validate against.
//
// excludeLineId (optional): needed by a coating job's own confirm-send
// check -- that job's SOURCE reservation line still carries its
// qtyPendingCoating as a "held" claim on the raw/mill pool right up until
// the send actually posts, so a naive available-to-reserve call double-
// counts the very job trying to use it against itself (physical 5,
// this job's own claim 3, another's claim 0 -> available comes back 2
// instead of 5, a false-negative "not enough stock" on a job that's the
// ONLY thing waiting on that stock). Passing that line's id here excludes
// it from the reserved-elsewhere sum, same as every other caller of
// getAlreadyReserved already does for its own line. Omitted (the default,
// every other caller) keeps today's behavior unchanged.
export async function getAvailableToReserve(storeId, itemId, color, lengthMm, excludeLineId, transaction) {
    const physical = await getPhysicalBalance(storeId, itemId, color, lengthMm, transaction);
    const reserved = await getAlreadyReserved(storeId, itemId, excludeLineId, color, lengthMm, transaction);
    return physical - reserved;
}

// Sum of qtyReserved across every other held reservation line for this
// store+item(+color) -- what a new reservation line's own available-to-
// reserve figure is competing against. Exposed separately from
// getAvailableToReserve so the reservation UI can show "already reserved: N"
// alongside "available: N" on the same line, not just the net figure.
export async function getAlreadyReserved(storeId, itemId, excludeLineId, color, lengthMm, transaction) {
    const where = { storeId, itemId, status: HELD_STATUSES, ...reservationItemColorWhere(color) };
    // Same "omitted = pooled, explicit = narrowed" convention as color --
    // see getPhysicalBalance. Deliberately NOT applied to the
    // qtyPendingCoating cross-check below -- that tier draws from the raw
    // pool by color alone today; scoping it to length too is real future
    // work, out of scope for this pass (adding the variant/barcode layer).
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhReservationItem.findAll({ where, transaction });
    let total = rows
        .filter((r) => r.id !== excludeLineId)
        .reduce((sum, r) => sum + r.qtyReserved, 0);

    // A painted-ALM line's qtyPendingCoating (material drawn from existing
    // mill-finish stock, routed straight to coating -- see
    // matWhReservations.js) always claims the raw/mill (null-color) pool
    // specifically, regardless of what color the line ITSELF displays --
    // so a raw-pool query has to sum it from every held line, not just
    // ones whose own color is null/MILL (which the where-clause above
    // already covers via qtyReserved). No double-count risk: a line only
    // ever carries qtyPendingCoating when it has a real painted color, and
    // qtyReserved on that same line is its EXACT-color reservation --
    // a completely different, non-overlapping bucket from the raw pool.
    if (color !== undefined && normalizeColor(color) === null) {
        const pendingRows = await MatWhReservationItem.findAll({
            where: { storeId, itemId, status: HELD_STATUSES },
            transaction,
        });
        total += pendingRows
            .filter((r) => r.id !== excludeLineId)
            .reduce((sum, r) => sum + (r.qtyPendingCoating || 0), 0);
    }
    return total;
}

// Sum of qtyRequested across every 'pending' line for this store+item
// (+color) -- submitted, awaiting that line's own store's confirm/reject
// decision. Not yet earmarked (only a confirmed/partially_confirmed line
// actually holds stock, see HELD_STATUSES above), but real demand already
// sitting in the queue -- shown alongside available/already-reserved so a
// storekeeper can see stock that's about to be spoken for if those
// pending requests get approved, not just what's already committed.
export async function getPendingQty(storeId, itemId, excludeLineId, color, lengthMm) {
    const where = { storeId, itemId, status: 'pending', ...reservationItemColorWhere(color) };
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhReservationItem.findAll({ where });
    return rows
        .filter((r) => r.id !== excludeLineId)
        .reduce((sum, r) => sum + r.qtyRequested, 0);
}

// Every distinct color this item has ever moved through at this store,
// each with its own real available-to-reserve figure -- what the coating
// send action's color picker offers, restricted (by the caller) to only
// those with available > 0. lengthMm optional, same "omitted = pooled,
// explicit = narrowed" convention as everywhere else -- a coating job's
// own fixed length should almost always be passed, since sending a
// different length's stock under this item code would be wrong even if
// some other length shows a real balance. Distinct colors come from the
// ledger itself (already write-normalized -- see postLedgerMovement),
// so 'MILL' never shows up as a separate row from null; querying with
// undefined lets a genuinely uncolored (non-ALM) item's single null
// bucket through too.
export async function getAvailableColorsForItem(storeId, itemId, lengthMm) {
    const where = { storeId, itemId };
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhStockLedger.findAll({
        where, attributes: ['color'], group: ['color'],
    });
    const colors = rows.map((r) => r.color ?? null);
    const results = [];
    for (const color of colors) {
        const available = await getAvailableToReserve(storeId, itemId, color, lengthMm);
        results.push({ color, available });
    }
    return results;
}

// WH.4. Feeds matWhItemCost's running valuation (one row per item+store,
// all colors/lengths pooled) from every cost-bearing inflow: goods
// receipt, opening balance, transfer receive (carrying the source cost),
// and a stock-count gain.
//
// The quantity already on hand comes from the ledger itself, not a stored
// counter: issues, write-offs, transfers out etc. never touched the old
// counter, so after stock went out the previous average kept far too much
// weight. Every caller posts this receipt's ledger movement first in the
// same transaction, so the balance read here already includes it.
// onHandQty is kept as the stock level at the last cost update (nothing
// reads it as live stock).
//
// The cost row is locked so two receipts at once can't lose an update; a
// receipt committed by another transaction while this one waited may be
// missing from this transaction's balance read, which only slightly
// under-weights the old average -- acceptable for a valuation figure.
// The item+store average cost right now (null when no cost is known) --
// stamped on an external_send so the coating request knows what the
// material it sent out was worth.
export async function currentAvgCost(itemId, storeId, transaction) {
    const row = await MatWhItemCost.findOne({ where: { itemId, storeId }, transaction });
    return row?.weightedAvgCost ?? null;
}

// Adds a service cost (e.g. the coating company's painting charge) to the
// value of the stock already on hand, without changing quantity: the
// average rises by extraValue / on-hand qty. Same pooled item+store row
// and on-hand source as applyReceiptCost. Returns what it did, or null
// when there's nothing on hand to carry the cost.
export async function addValueToStock(itemId, storeId, extraValue, transaction) {
    if (!(extraValue > 0)) return null;
    const onHand = await getPhysicalBalance(storeId, itemId, undefined, undefined, transaction);
    if (!(onHand > 0)) return null;
    const [created] = await MatWhItemCost.findOrCreate({
        where: { itemId, storeId },
        defaults: { lastCost: null, weightedAvgCost: null, onHandQty: 0 },
        transaction,
    });
    const row = await lockRow(MatWhItemCost, created.id, transaction);
    const previousAvg = row.weightedAvgCost ?? null;
    const newAvg = (previousAvg ?? 0) + extraValue / onHand;
    await row.update({
        weightedAvgCost: newAvg,
        onHandQty: onHand,
        currentCost: row.costMethod === 'weightedAvg' ? newAvg : row.currentCost,
        lastUpdated: new Date(),
    }, { transaction });
    return { itemId, storeId, onHand, oldAvg: previousAvg, newAvg, added: extraValue };
}

export async function applyReceiptCost(itemId, storeId, qtyAccepted, unitCost, transaction) {
    if (!qtyAccepted || unitCost == null) return;

    const [created] = await MatWhItemCost.findOrCreate({
        where: { itemId, storeId },
        defaults: { lastCost: null, weightedAvgCost: null, onHandQty: 0 },
        transaction,
    });
    const row = await lockRow(MatWhItemCost, created.id, transaction);

    const newOnHand = await getPhysicalBalance(storeId, itemId, undefined, undefined, transaction);
    const oldOnHand = Math.max(0, newOnHand - qtyAccepted);
    const newWeightedAvg = oldOnHand > 0 && row.weightedAvgCost != null
        ? (oldOnHand * row.weightedAvgCost + qtyAccepted * unitCost) / newOnHand
        : unitCost;
    const newLastCost = unitCost;
    const currentCost = row.costMethod === 'weightedAvg' ? newWeightedAvg : newLastCost;

    await row.update({
        lastCost: newLastCost,
        weightedAvgCost: newWeightedAvg,
        onHandQty: newOnHand,
        currentCost,
        lastUpdated: new Date(),
    }, { transaction });
}
