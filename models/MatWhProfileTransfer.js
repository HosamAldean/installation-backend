// backend/models/MatWhProfileTransfer.js
// IIT_Petra.matWhProfileTransfers -- internal stock movement in/out of a
// store, unrelated to sending material to an external coating company.
// Replaces the IN/OUT half of Stock House's guest.MIXO/MIX pair (see
// MatWhProfileCoatingBatch for the separate coating-send half legacy
// overloaded onto the same two tables).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileTransfer = sequelizeUtf8.define('MatWhProfileTransfer', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    direction: { type: DataTypes.STRING(10), allowNull: false }, // in, out
    projectNo: { type: DataTypes.STRING(50), allowNull: false },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    projectManager: { type: DataTypes.STRING(255), allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    stockOfficer: { type: DataTypes.STRING(255), allowNull: true },
    stockManager: { type: DataTypes.STRING(255), allowNull: true },
    transferredBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileTransfers',
    timestamps: true,
});
