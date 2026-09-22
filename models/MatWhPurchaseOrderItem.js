// backend/models/MatWhPurchaseOrderItem.js
// IIT_Petra.matWhPurchaseOrderItems -- WH.2 PO line items.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhPurchaseOrderItem = sequelizeUtf8.define('MatWhPurchaseOrderItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    purchaseOrderId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    qtyOrdered: { type: DataTypes.FLOAT, allowNull: false },
    // Nullable/defaulted: an auto-generated line (from a reservation
    // shortfall) doesn't know a price yet -- filled in later same as any
    // other draft PO line.
    unitPrice: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    lineAmt: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    // Set only on a line auto-generated from a reservation shortfall --
    // traces the PO line back to the reservation line that raised it.
    reservationItemId: { type: DataTypes.INTEGER, allowNull: true },
    // Copied from the reservation line's itemNeededByDate at confirm time
    // -- lets a buyer prioritize an auto-generated PO's lines by actual
    // project urgency instead of just PO creation order.
    neededByDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Same fields/shape as MatWhReservationItem's own color/lengthMm --
    // a manually-created PO for an aluminum item needs to specify a
    // coating color too, not just an auto-generated one (which never
    // carried this before -- reservations didn't either until later).
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    // Set only by the auto-routing logic in services/matWhReservations.js
    // when a painted ALM reservation line's shortfall is covered by buying
    // mill-finish stock instead (color above is null on such a line --
    // that's what's actually being procured) -- this remembers what color
    // it needs to become once coated, carried through to the draft
    // external-processing job the goods receipt auto-creates. Never set on
    // a manually-created PO line.
    targetColor: { type: DataTypes.STRING(50), allowNull: true },
}, {
    tableName: 'matWhPurchaseOrderItems',
    timestamps: true,
});
