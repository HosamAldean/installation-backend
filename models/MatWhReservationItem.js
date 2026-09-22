// backend/models/MatWhReservationItem.js
// IIT_Petra.matWhReservationItems -- one line of a MatWhReservationHeader.
// Replaces the old flat MatWhReservation (which combined header+line into
// one row with no multi-item grouping). storeId is the item's REAL store
// (MatWhItemStore.js) -- a technician picks it per line at add time (one
// choice if the item lives in exactly one store, a pick among its real
// stores if it lives in more than one, any store if there's no evidence
// either way), which is also why confirm/reject happen per line: each
// store only ever sees and decides on its own lines, not the whole
// reservation. Confirming a line still deliberately does NOT post to
// matWhStockLedger -- it only earmarks stock (Stock House's Reservation/
// ReReservation2 precedent, §07). Issuing one DOES post (direction 'out',
// docType 'issue') -- the actual physical hand-over to the site/technician
// (WM 10-22), a separate later stage -- see services/matWhReservations.js.
//
// qtyRequested vs. qtyReserved: requested is what the line asked for when
// added to the draft; reserved is what actually got earmarked once the
// header was confirmed (min(qtyRequested, availableAtConfirmTime)).
// qtyShortfall is the remainder, which an auto-generated purchase order
// covers -- see services/matWhReservations.js's confirmReservation.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhReservationItem = sequelizeUtf8.define('MatWhReservationItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    reservationHeaderId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // User-entered per line -- different items in the same reservation can
    // be needed on different dates for the same project.
    itemNeededByDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Aluminum-only dimensions (WM 10-21/10-22 "اللون"/"الطول") -- null for
    // accessory (non-ALM) lines. Same field names/types as the orphaned
    // MatWhProfileStock's own color/lengthMm (models/MatWhProfileStock.js),
    // kept consistent even though that table has nothing to join to
    // anymore -- these are plain per-line attributes here, not a stock key.
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    qtyRequested: { type: DataTypes.FLOAT, allowNull: false },
    qtyReserved: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    qtyShortfall: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    // pending (submitted, awaiting this line's own store's decision) ->
    // confirmed (qtyReserved == qtyRequested) / partially_confirmed
    // (qtyShortfall > 0, PO raised) -> issued (storekeeper physically
    // handed qtyReserved over) OR released (project no longer needs it,
    // hold given up without ever issuing) -- OR, straight from pending,
    // rejected (this store turned the line down, see rejectionReason).
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    // Set only when this line had a shortfall at confirm time.
    purchaseOrderId: { type: DataTypes.INTEGER, allowNull: true },
    purchaseOrderItemId: { type: DataTypes.INTEGER, allowNull: true },
    reservedBy: { type: DataTypes.INTEGER, allowNull: true },
    reservedDate: { type: DataTypes.DATE, allowNull: true },
    // Set only once the storekeeper issues this line (qtyReserved leaves
    // the store for real -- see the ledger comment above).
    issuedBy: { type: DataTypes.INTEGER, allowNull: true },
    issuedDate: { type: DataTypes.DATE, allowNull: true },
    // The specific physical piece's own barcode (aluminum is cut per piece
    // and each piece carries its own barcode in Alpha/the old Stock House
    // system -- matWhItems.barcode is only the item-TYPE's barcode, same
    // one for every piece of that profile). Captured by the storekeeper at
    // issue time, free text -- there's no live per-piece inventory table to
    // validate against (MatWhProfileStock, which modeled exactly that, is
    // abandoned -- see MatWhItem.js), so this is a factual record of what
    // was handed over, not a checked reference.
    issuedBarcode: { type: DataTypes.STRING(50), allowNull: true },
    releasedDate: { type: DataTypes.DATE, allowNull: true },
    // Set only when this line's store rejects it (WM 10-21) -- reason is
    // required at the route level, not just optional metadata.
    rejectedBy: { type: DataTypes.INTEGER, allowNull: true },
    rejectedDate: { type: DataTypes.DATE, allowNull: true },
    rejectionReason: { type: DataTypes.STRING(500), allowNull: true },
    // Set only on a line CREATED as a substitute (see the /substitute
    // route in services/matWhReservations.js) -- points back at the
    // shortfall line it covers, on the same header. Compensates for a
    // shortfall with a different item/color/length that's actually in
    // stock, as an alternative to only ever waiting on the shortfall's
    // auto-generated PO (which is left untouched, same "don't implicitly
    // touch an already-raised PO" precedent as releasing a reservation).
    substitutesLineId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhReservationItems',
    timestamps: true,
});
