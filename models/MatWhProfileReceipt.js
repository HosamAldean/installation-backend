// backend/models/MatWhProfileReceipt.js
// IIT_Petra.matWhProfileReceipts -- receive raw material into the Profile
// Store, QC evaluation as first-class fields, replacing Stock House's
// guest.EnterDouO/EnterDou pair. Flattened to one row per receipt: legacy
// data confirmed every EnterDou header ever written carries exactly one
// detail line (single-item-at-a-time scan flow), so the header/subform
// split served no purpose here.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileReceipt = sequelizeUtf8.define('MatWhProfileReceipt', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    supplier: { type: DataTypes.STRING(255), allowNull: true },
    projectNo: { type: DataTypes.STRING(50), allowNull: true },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: false },
    qtyEvaluated: { type: DataTypes.FLOAT, allowNull: true },
    qtyLoss: { type: DataTypes.FLOAT, allowNull: true },
    qtyRejected: { type: DataTypes.FLOAT, allowNull: true },
    weight: { type: DataTypes.FLOAT, allowNull: true },
    unit: { type: DataTypes.STRING(20), allowNull: true },
    whouseOfficer: { type: DataTypes.STRING(255), allowNull: true },
    whouseDate: { type: DataTypes.DATE, allowNull: true },
    qcOfficer: { type: DataTypes.STRING(255), allowNull: true },
    qcDate: { type: DataTypes.DATE, allowNull: true },
    qcTestNo: { type: DataTypes.STRING(50), allowNull: true },
    qcTestResult: { type: DataTypes.STRING(50), allowNull: true },
    qcTestDate: { type: DataTypes.DATE, allowNull: true },
    // Set when this receipt is the stock-in side of a coating batch coming
    // back, rather than a genuine new supplier delivery -- lets the receipt
    // history explain where the material actually came from.
    sourceCoatingBatchId: { type: DataTypes.INTEGER, allowNull: true },
    enteredBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileReceipts',
    timestamps: true,
});
