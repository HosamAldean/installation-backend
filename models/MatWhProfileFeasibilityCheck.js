// backend/models/MatWhProfileFeasibilityCheck.js
// IIT_Petra.matWhProfileFeasibilityChecks -- production checking whether a
// profile/color/length is available before committing to a real
// reservation, against a specific production order. Replaces Stock House's
// guest.ReservationFO/ReservationF pair (flattened, same reasoning as
// MatWhProfileReceipt). qtyAvailableAtCheck/feasible are computed for real
// from current on-hand stock at check time, not manually typed.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileFeasibilityCheck = sequelizeUtf8.define('MatWhProfileFeasibilityCheck', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: false },
    productionNo: { type: DataTypes.STRING(50), allowNull: false },
    qtyRequested: { type: DataTypes.FLOAT, allowNull: false },
    qtyAvailableAtCheck: { type: DataTypes.FLOAT, allowNull: false },
    feasible: { type: DataTypes.BOOLEAN, allowNull: false },
    weight: { type: DataTypes.FLOAT, allowNull: true },
    checkedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileFeasibilityChecks',
    timestamps: true,
});
