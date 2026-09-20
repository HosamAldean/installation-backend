// backend/models/MatWhSupplierInvoice.js
// IIT_Petra.matWhSupplierInvoices -- WH.2. Arrives independently of
// receipt, often later (7+ days observed) -- matched back to a
// matWhGoodsReceipt once it does. See the Alpha Warehouse Analysis report
// §10 and §08 (Mix Paints, a plain vendor relationship under this same
// table).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhSupplierInvoice = sequelizeUtf8.define('MatWhSupplierInvoice', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    purchaseOrderId: { type: DataTypes.INTEGER, allowNull: false },
    goodsReceiptId: { type: DataTypes.INTEGER, allowNull: true },
    vendorInvoiceNo: { type: DataTypes.STRING(100), allowNull: false },
    invDate: { type: DataTypes.DATEONLY, allowNull: true },
    invReceivedDate: { type: DataTypes.DATE, allowNull: false },
    invDueDate: { type: DataTypes.DATEONLY, allowNull: true },
    netAmt: { type: DataTypes.FLOAT, allowNull: true },
    matchStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unmatched' }, // unmatched, matched
    enteredBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhSupplierInvoices',
    timestamps: true,
});
