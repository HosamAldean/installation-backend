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
export async function getPhysicalBalance(storeId, itemId, color, lengthMm) {
    const where = { storeId, itemId };
    if (color !== undefined) where.color = normalizeColor(color);
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhStockLedger.findAll({ where });
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
export async function getAvailableToReserve(storeId, itemId, color, lengthMm, excludeLineId) {
    const physical = await getPhysicalBalance(storeId, itemId, color, lengthMm);
    const reserved = await getAlreadyReserved(storeId, itemId, excludeLineId, color, lengthMm);
    return physical - reserved;
}

// Sum of qtyReserved across every other held reservation line for this
// store+item(+color) -- what a new reservation line's own available-to-
// reserve figure is competing against. Exposed separately from
// getAvailableToReserve so the reservation UI can show "already reserved: N"
// alongside "available: N" on the same line, not just the net figure.
export async function getAlreadyReserved(storeId, itemId, excludeLineId, color, lengthMm) {
    const where = { storeId, itemId, status: HELD_STATUSES, ...reservationItemColorWhere(color) };
    // Same "omitted = pooled, explicit = narrowed" convention as color --
    // see getPhysicalBalance. Deliberately NOT applied to the
    // qtyPendingCoating cross-check below -- that tier draws from the raw
    // pool by color alone today; scoping it to length too is real future
    // work, out of scope for this pass (adding the variant/barcode layer).
    if (lengthMm !== undefined) where.lengthMm = lengthMm;
    const rows = await MatWhReservationItem.findAll({ where });
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

// WH.4. Feeds matWhItemCost's running valuation -- called only from a
// goods-receipt posting (the actual acquisition/cost event), matching
// Alpha's own real precedent (Ord_GetItemUnitCost only concerns itself
// with purchase receipts, §05). NOT called for transfer/external-
// processing/other ledger movements -- those change physical balance
// (tracked by getPhysicalBalance/getAvailableToReserve above) without
// being a new cost-bearing acquisition. This is a deliberate scope
// boundary, not an oversight: onHandQty here is a cost-basis quantity for
// the weighted-average calculation, not a live mirror of physical balance
// -- keeping the two fully reconciled across every movement type (issues,
// write-offs, transfer cost carry-forward) is real future work.
export async function applyReceiptCost(itemId, storeId, qtyAccepted, unitCost, transaction) {
    if (!qtyAccepted || unitCost == null) return;

    const [row] = await MatWhItemCost.findOrCreate({
        where: { itemId, storeId },
        defaults: { lastCost: null, weightedAvgCost: null, onHandQty: 0 },
        transaction,
    });

    const oldOnHand = row.onHandQty || 0;
    const newOnHand = oldOnHand + qtyAccepted;
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
