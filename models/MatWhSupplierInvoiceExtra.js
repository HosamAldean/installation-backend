// backend/models/MatWhSupplierInvoiceExtra.js
// IIT_Petra.matWhSupplierInvoiceExtras -- extra costs on a purchase invoice
// (2026-10-29): freight, customs & clearance, transport/unloading,
// insurance, other. Each can be in its own currency (local clearance in
// JOD on a USD invoice) and name a different vendor (the shipping
// company). amountJod is spread over the invoice's items by value and
// becomes part of their landed cost.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const SUPPLIER_INVOICE_EXTRA_TYPES = ['freight', 'customs', 'transport', 'insurance', 'other'];

export const MatWhSupplierInvoiceExtra = sequelizeUtf8.define('MatWhSupplierInvoiceExtra', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    supplierInvoiceId: { type: DataTypes.INTEGER, allowNull: false },
    costType: { type: DataTypes.STRING(20), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    vendorId: { type: DataTypes.INTEGER, allowNull: true },
    amount: { type: DataTypes.FLOAT, allowNull: false },
    currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'JOD' },
    exchangeRate: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 1 },
    amountJod: { type: DataTypes.FLOAT, allowNull: false },
}, {
    tableName: 'matWhSupplierInvoiceExtras',
    timestamps: true,
});
