// backend/models/MatWhCoatingInvoice.js
// IIT_Petra.matWhCoatingInvoices -- Mix's (the coating vendor's) own
// invoice for a finished coating request, keyed by requestNo (a coating
// job group -- see services/matWhReservations.js's createCoatingJob) since
// a coating job has no purchaseOrderId to hang off. Kept as its own small
// table instead of loosening MatWhSupplierInvoice's required
// purchaseOrderId FK, so that model's own PO-matching logic (invoiceStatus,
// finalUnitCost backfill) stays exactly as strict as it already is.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhCoatingInvoice = sequelizeUtf8.define('MatWhCoatingInvoice', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    requestNo: { type: DataTypes.STRING(50), allowNull: false },
    processVendorId: { type: DataTypes.INTEGER, allowNull: true },
    vendorInvoiceNo: { type: DataTypes.STRING(100), allowNull: false },
    invDate: { type: DataTypes.DATEONLY, allowNull: true },
    invReceivedDate: { type: DataTypes.DATE, allowNull: false },
    invDueDate: { type: DataTypes.DATEONLY, allowNull: true },
    netAmt: { type: DataTypes.FLOAT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    enteredBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhCoatingInvoices',
    timestamps: true,
});
