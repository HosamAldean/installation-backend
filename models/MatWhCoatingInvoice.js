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
    // Mix's own charge for the painting/service work -- what Mix itself
    // invoices for, entered by a mix_manager account. Distinct from
    // materialCost below, which the warehouse adds on its own side at
    // approval time -- per direct request, the two must stay visibly
    // separate ("retaining original invoice details") rather than being
    // collapsed into one editable total the warehouse could silently
    // overwrite.
    paintingCost: { type: DataTypes.FLOAT, allowNull: true },
    // Filled in by the warehouse (requireInvoices, internal staff) at
    // approval time -- the real historical cost of the original material
    // this job coated, which only the warehouse side actually knows.
    materialCost: { type: DataTypes.FLOAT, allowNull: true },
    // materialCost + paintingCost, computed and stored (not derived on
    // every read) at the moment of approval -- a stable snapshot for
    // audit even if either input field were somehow edited later.
    totalCost: { type: DataTypes.FLOAT, allowNull: true },
    // pending (awaiting warehouse review) -> approved | rejected. Only
    // ever set by the warehouse side (POST .../invoices/:id/approve or
    // .../reject in materialsWarehouseOperations.js) -- Mix's own POST
    // that creates the row always starts it at 'pending'.
    approvalStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    approvedBy: { type: DataTypes.INTEGER, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    enteredBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhCoatingInvoices',
    timestamps: true,
});
