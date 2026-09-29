// backend/models/MatWhExternalProcessing.js
// IIT_Petra.matWhExternalProcessing -- material sent to an outside
// processor (e.g. a coating company) and received back. Modeled after
// Stock House's MIX table (§07), generalized beyond coating specifically.
// Unlike reservations, this IS a real physical movement out of and back
// into the store, so both the send and the receive-back post to
// matWhStockLedger.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhExternalProcessing = sequelizeUtf8.define('MatWhExternalProcessing', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // Auto-generated, never typed by hand -- same "COAT-000123" idea as
    // MatWhPurchaseOrder.poNo's own PO-AUTO-000123 numbering, for every job
    // (manual Send Out included), so a coating request always has a real
    // reference number to quote/track by. NOT unique -- per direct request,
    // every coating job raised for the same (reservation, store) pairing
    // shares ONE request number (see matWhReservations.js's
    // createCoatingJob), so this column legitimately repeats across rows.
    requestNo: { type: DataTypes.STRING(50), allowNull: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // Companion to targetColor -- a coating job's own source reservation/PO
    // line has always carried lengthMm, this job just never did. Needed to
    // resolve the exact matWhItemVariants row (item+color+length->barcode)
    // for the barcode-confirmed send/receive gate.
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    processVendorId: { type: DataTypes.INTEGER, allowNull: true },
    qtySent: { type: DataTypes.FLOAT, allowNull: false },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: true },
    // Nullable -- a 'draft' job (see status below) has no send event yet.
    // Every job created through the existing manual POST /external-
    // processing route still gets a real sentDate immediately, same as
    // before this field became nullable.
    sentDate: { type: DataTypes.DATE, allowNull: true },
    receivedDate: { type: DataTypes.DATE, allowNull: true },
    // draft (auto-created from a mill-finish goods receipt, not yet a real
    // physical movement -- see routes/materialsWarehousePurchasing.js's
    // POST /goods-receipts) -> sent (storekeeper picked a vendor and
    // confirmed, POST /external-processing/:id/confirm-send -- THIS is
    // when the 'out' ledger movement actually posts) -> received. A
    // manually-created job (the existing POST /external-processing) skips
    // 'draft' entirely and starts at 'sent', unchanged from before.
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sent' }, // draft, sent, received
    sentBy: { type: DataTypes.INTEGER, allowNull: true },
    receivedBy: { type: DataTypes.INTEGER, allowNull: true },
    // What color this job is expected to come back as once coated --
    // null for an ordinary (non-coating) external-processing job. Set
    // alongside sourceReservationItemId below when auto-created.
    targetColor: { type: DataTypes.STRING(50), allowNull: true },
    // What color is actually being sent out -- null (mill-finish) for
    // every job created before this field existed, and still the default
    // for a new one unless the storekeeper explicitly picks a different
    // already-in-stock color at confirm-send time (routes/
    // materialsWarehouseOperations.js's POST /confirm-send, restricted
    // there to colors this item actually has available stock of at that
    // store -- per direct request, re-coating existing painted stock to a
    // new targetColor instead of always assuming mill). Only ever set at
    // send time, alongside status -> 'sent'; stays null on a still-draft
    // job since nothing's been sent yet.
    sourceColor: { type: DataTypes.STRING(50), allowNull: true },
    // Set only on an auto-created draft job -- which reservation line it
    // exists to eventually fulfill (via the separate, explicit
    // POST /reservations/:id/items/:lineId/fulfill-shortfall action once
    // the coated stock is actually received back -- this FK alone doesn't
    // auto-apply anything).
    sourceReservationItemId: { type: DataTypes.INTEGER, allowNull: true },
    // Set only on an auto-created draft job -- the exact MatWhPurchaseOrderItem
    // (the mill-finish shortfall line) this job exists to receive material
    // for. Set at reservation-confirm time now, before any receipt exists
    // (see services/matWhReservations.js), so a later goods receipt against
    // that same PO item can find THIS row and accumulate qtySent into it
    // instead of creating a duplicate job -- direct FK, not derived via
    // sourceReservationItemId, because a reservation line's PO item is the
    // one unambiguous key a receipt line already has in hand.
    sourcePurchaseOrderItemId: { type: DataTypes.INTEGER, allowNull: true },
    // True only for a job auto-created from a mill-finish goods receipt --
    // never for one a storekeeper started by hand through the External
    // Processing page's own "Send Out" dialog. Same convention as
    // MatWhPurchaseOrder.isAutoGenerated.
    isAutoGenerated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Mix's (the coating vendor's) own progress reporting on a job that's
    // already 'sent', tracked separately from the physical send/receive-
    // back ledger movements above -- per direct request, staff need to log
    // what Mix tells them by phone/paper (they got the batch, an ETA, then
    // it's actually done) before the coated material physically comes back
    // through this store's own door (that's still POST /:id/receive,
    // unchanged, and can trail this by days). Set together, per requestNo
    // group, via POST /external-processing/group/:requestNo/confirm-
    // received and .../actual-finish.
    notes: { type: DataTypes.TEXT, allowNull: true },
    estimatedDeliveryDate: { type: DataTypes.DATEONLY, allowNull: true },
    confirmedReceivedAt: { type: DataTypes.DATE, allowNull: true },
    confirmedReceivedBy: { type: DataTypes.INTEGER, allowNull: true },
    actualFinishDate: { type: DataTypes.DATEONLY, allowNull: true },
}, {
    tableName: 'matWhExternalProcessing',
    timestamps: true,
});
