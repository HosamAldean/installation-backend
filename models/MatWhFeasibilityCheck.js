// backend/models/MatWhFeasibilityCheck.js
// IIT_Petra.matWhFeasibilityChecks -- pre-reservation availability check
// against a production reference, before a formal reservation is made.
// Modeled after Stock House's ReservationF (§07). Read-mostly: doesn't move
// or earmark anything itself.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhFeasibilityCheck = sequelizeUtf8.define('MatWhFeasibilityCheck', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    productionRef: { type: DataTypes.STRING(50), allowNull: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // Null for a non-color-tracked item, or a check against the pooled
    // total regardless of color -- matches services/matWhLedger.js's own
    // "omit means don't filter" convention.
    color: { type: DataTypes.STRING(50), allowNull: true },
    qtyRequested: { type: DataTypes.FLOAT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false }, // feasible, not_feasible
    checkedBy: { type: DataTypes.INTEGER, allowNull: true },
    checkedDate: { type: DataTypes.DATE, allowNull: false },
}, {
    tableName: 'matWhFeasibilityChecks',
    timestamps: true,
});
