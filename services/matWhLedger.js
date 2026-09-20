// backend/services/matWhLedger.js
// Shared helpers for the WH.3 unified stock ledger -- used by
// routes/materialsWarehouseOperations.js (reservations, external
// processing, manual movements) and routes/materialsWarehousePurchasing.js
// (goods receipt posts here too, per the Alpha Warehouse Analysis report
// §10: receipt makes stock usable immediately, independent of invoicing).
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { MatWhReservationItem } from '../models/MatWhReservationItem.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';

// Lines that count against availability: confirmed in full, or confirmed
// for whatever was available with the rest covered by an auto-PO. A
// 'pending' line (still sitting in someone's draft reservation) does not
// hold stock yet -- only Confirm Reservation does that, same as the old
// flat model's 'active' status did.
const HELD_STATUSES = ['confirmed', 'partially_confirmed'];

// Appends one ledger row. `transaction` is required for callers already
// inside one (goods receipt, external processing) -- pass undefined for a
// standalone call.
export async function postLedgerMovement({
    storeId, itemId, projectId, qty, direction, docType, refType, refId,
    unitCost, performedBy,
}, transaction) {
    return MatWhStockLedger.create({
        storeId, itemId, projectId: projectId ?? null,
        qty, direction, docType, refType: refType ?? null, refId: refId ?? null,
        unitCost: unitCost ?? null,
        totalCost: unitCost != null ? unitCost * qty : null,
        movementDate: new Date(),
        performedBy: performedBy ?? null,
    }, { transaction });
}

// Physical on-hand balance for one store+item: sum(in) - sum(out) across
// the whole ledger. Does not account for reservations -- see
// getAvailableToReserve for the figure that actually matters when deciding
// whether a new reservation can be made.
export async function getPhysicalBalance(storeId, itemId) {
    const rows = await MatWhStockLedger.findAll({ where: { storeId, itemId } });
    let balance = 0;
    for (const r of rows) balance += r.direction === 'in' ? r.qty : -r.qty;
    return balance;
}

// Available-to-reserve = physical balance - currently active reservations
// for the same store+item. This is the figure feasibility checks and new
// reservations actually validate against.
export async function getAvailableToReserve(storeId, itemId) {
    const physical = await getPhysicalBalance(storeId, itemId);
    const reserved = await getAlreadyReserved(storeId, itemId);
    return physical - reserved;
}

// Sum of qtyReserved across every other held reservation line for this
// store+item -- what a new reservation line's own available-to-reserve
// figure is competing against. Exposed separately from
// getAvailableToReserve so the reservation UI can show "already reserved: N"
// alongside "available: N" on the same line, not just the net figure.
export async function getAlreadyReserved(storeId, itemId, excludeLineId) {
    const where = { storeId, itemId, status: HELD_STATUSES };
    const rows = await MatWhReservationItem.findAll({ where });
    return rows
        .filter((r) => r.id !== excludeLineId)
        .reduce((sum, r) => sum + r.qtyReserved, 0);
}

// Sum of qtyRequested across every 'pending' line for this store+item --
// submitted, awaiting that line's own store's confirm/reject decision.
// Not yet earmarked (only a confirmed/partially_confirmed line actually
// holds stock, see HELD_STATUSES above), but real demand already sitting
// in the queue -- shown alongside available/already-reserved so a
// storekeeper can see stock that's about to be spoken for if those
// pending requests get approved, not just what's already committed.
export async function getPendingQty(storeId, itemId, excludeLineId) {
    const rows = await MatWhReservationItem.findAll({ where: { storeId, itemId, status: 'pending' } });
    return rows
        .filter((r) => r.id !== excludeLineId)
        .reduce((sum, r) => sum + r.qtyRequested, 0);
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
