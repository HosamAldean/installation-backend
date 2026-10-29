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
    // The PO line this invoice line bills (2026-10-29) -- lets aluminium
    // colour/length variants of the same item match their own receipt
    // lines instead of collapsing onto one itemId.
    poItemId: { type: DataTypes.INTEGER, allowNull: true },
    // JOD per unit after the discount and extra-cost shares, before VAT --
    // what the matched receipt's finalUnitCost becomes.
    landedUnitCost: { type: DataTypes.FLOAT, allowNull: true },
}, {
    tableName: 'matWhSupplierInvoiceItems',
    timestamps: true,
});
