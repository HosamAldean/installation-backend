// backend/models/MatWhGoodsReceipt.js
// IIT_Petra.matWhGoodsReceipts -- WH.2. Posts as soon as material is
// physically received and QC'd, independent of whether the vendor's
// invoice has arrived yet -- invoiceStatus tracks that separately and
// starts 'pending' by design (Alpha Warehouse Analysis report §10:
// receipt/invoice decoupling, confirmed for every vendor, invoices
// regularly trailing 7+ days).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhGoodsReceipt = sequelizeUtf8.define('MatWhGoodsReceipt', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    purchaseOrderId: { type: DataTypes.INTEGER, allowNull: false },
    shipmentRef: { type: DataTypes.STRING(50), allowNull: true },
    receivedDate: { type: DataTypes.DATE, allowNull: false },
    landCost: { type: DataTypes.FLOAT, allowNull: true },
    locExpenses: { type: DataTypes.FLOAT, allowNull: true },
    othExpenses: { type: DataTypes.FLOAT, allowNull: true },
    qcCheckedBy: { type: DataTypes.INTEGER, allowNull: true },
    qcCheckedDate: { type: DataTypes.DATE, allowNull: true },
    invoiceStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' }, // pending, matched
    receivedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhGoodsReceipts',
    timestamps: true,
});
