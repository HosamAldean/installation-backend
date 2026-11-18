// backend/models/MatWhProjectPlan.js
// IIT_Petra.matWhProjectPlans -- production's material plan for one order /
// phase of a project (2026-11-01). Lines (MatWhProjectPlanItem) come from an
// Excel paste or the grid; production checks them against the stores before
// the planned start date and then requests all or some of them, which
// creates an ordinary production request (MatWhReservationHeader with
// projectPlanId set). Checking never holds stock -- it only warns.
//
// status: draft (still being filled) -> active (at least one line
// requested) -> closed (production finished with it; read-only).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProjectPlan = sequelizeUtf8.define('MatWhProjectPlan', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: true },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    projectManager: { type: DataTypes.STRING(255), allowNull: true },
    // The order / phase of the project this plan covers, free text
    // ("Order 3", "Phase B - tower 2").
    orderRef: { type: DataTypes.STRING(100), allowNull: false },
    plannedStartDate: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    lastCheckedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProjectPlans',
    timestamps: true,
});
