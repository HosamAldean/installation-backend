// backend/models/MatWhProfileCoatingBatch.js
// IIT_Petra.matWhProfileCoatingBatches -- mill-finish stock sent to an
// external coating company and received back, replacing Stock House's
// guest.MIXO/MIX pair (the coating-send half only -- see
// MatWhProfileTransfer for the separate IN/OUT internal-movement half that
// legacy overloaded onto the same two tables). qtyReceived accumulates
// across partial deliveries; a receive posts a MatWhProfileReceipt row
// (sourceCoatingBatchId set) for the coated stock under its own barcode.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileCoatingBatch = sequelizeUtf8.define('MatWhProfileCoatingBatch', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // Mill-finish source stock being sent out.
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: false },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    projectManager: { type: DataTypes.STRING(255), allowNull: true },
    coatingCompany: { type: DataTypes.STRING(255), allowNull: true },
    targetColor: { type: DataTypes.STRING(50), allowNull: false },
    requestNo: { type: DataTypes.STRING(50), allowNull: true },
    stockOfficer: { type: DataTypes.STRING(255), allowNull: true },
    stockManager: { type: DataTypes.STRING(255), allowNull: true },
    qtySent: { type: DataTypes.FLOAT, allowNull: false },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    receivedColor1: { type: DataTypes.STRING(50), allowNull: true },
    dateSend: { type: DataTypes.DATE, allowNull: true },
    dateLastReceive: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sent' }, // sent, partially_received, received
    // The reservation this batch is fulfilling, if any.
    reservationId: { type: DataTypes.INTEGER, allowNull: true },
    sentBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileCoatingBatches',
    timestamps: true,
});
