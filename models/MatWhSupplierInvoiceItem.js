// backend/models/MatWhSupplierInvoiceItem.js
// IIT_Petra.matWhSupplierInvoiceItems -- WH.2 invoice line items.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhSupplierInvoiceItem = sequelizeUtf8.define('MatWhSupplierInvoiceItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    supplierInvoiceId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    unitPrice: { type: DataTypes.FLOAT, allowNull: false },
    lineAmt: { type: DataTypes.FLOAT, allowNull: false },
}, {
    tableName: 'matWhSupplierInvoiceItems',
    timestamps: true,
});
