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
    // Landed cost (2026-10-29). Line prices, netAmt and discountAmt are in
    // the invoice's currency; exchangeRate converts to JOD (1 for a JOD
    // invoice, and for every invoice entered before this existed).
    currency: { type: DataTypes.STRING(10), allowNull: true },
    exchangeRate: { type: DataTypes.FLOAT, allowNull: true },
    // Header discount, spread over the lines by value -- lowers item cost.
    discountAmt: { type: DataTypes.FLOAT, allowNull: true },
    // VAT is what's owed to the vendor but never part of item cost.
    vatRate: { type: DataTypes.FLOAT, allowNull: true },
    vatAmt: { type: DataTypes.FLOAT, allowNull: true },
    // Payable to the vendor, invoice currency: netAmt - discountAmt + vatAmt.
    grossAmt: { type: DataTypes.FLOAT, allowNull: true },
    // Sum of matWhSupplierInvoiceExtras.amountJod.
    extraCostsJod: { type: DataTypes.FLOAT, allowNull: true },
    // What the goods cost in stock, JOD: (netAmt - discountAmt) x rate + extras.
    landedTotalJod: { type: DataTypes.FLOAT, allowNull: true },
    // Price/qty differences against the PO found when it was entered
    // (JSON array of { itemId, poItemId, type, message }) -- kept for audit.
    priceWarnings: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'matWhSupplierInvoices',
    timestamps: true,
});
