// backend/models/MatWhGoodsReceiptItem.js
// IIT_Petra.matWhGoodsReceiptItems -- WH.2. Quantity split by QC outcome
// (same accept/loss/reject shape as Stock House's EnterDou) rather than a
// single received quantity. Cost starts provisional (from the PO's
// unitPrice) and is trued up to finalUnitCost once the vendor's invoice
// matches back -- see the Alpha Warehouse Analysis report §10.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhGoodsReceiptItem = sequelizeUtf8.define('MatWhGoodsReceiptItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    goodsReceiptId: { type: DataTypes.INTEGER, allowNull: false },
    poItemId: { type: DataTypes.INTEGER, allowNull: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: false },
    qtyAccepted: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    qtyLoss: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    qtyRejected: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    provisionalUnitCost: { type: DataTypes.FLOAT, allowNull: true },
    finalUnitCost: { type: DataTypes.FLOAT, allowNull: true },
    // Set by WH.3 when the accepted quantity posts to matWhStockLedger
    // (null if qtyAccepted was 0 -- nothing to post). Lets a later invoice
    // match (§10) true up that exact ledger row's cost directly, instead
    // of re-deriving it by refType/refId lookup.
    ledgerEntryId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhGoodsReceiptItems',
    timestamps: true,
});
