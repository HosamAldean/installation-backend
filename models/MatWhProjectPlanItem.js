// backend/models/MatWhProjectPlanItem.js
// IIT_Petra.matWhProjectPlanItems -- one material line on a project plan
// (MatWhProjectPlan). storeId may stay empty until production picks one
// (an item kept in several stores); a line needs it before it can be
// requested.
//
// The check* fields are the last availability check's snapshot (see
// services/matWhProjectPlans.js's checkPlan), so the plan shows its status
// without re-reading every balance on each page load. checkStatus:
// available / from_mill (raw stock can be coated) / incoming (covered once
// open POs and coating come in) / short.
//
// reservationHeaderId/reservationItemId link a requested line to the
// production request line it became; a line whose request line was
// rejected or released can be requested again.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProjectPlanItem = sequelizeUtf8.define('MatWhProjectPlanItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    planId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: true },
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    qtyPlanned: { type: DataTypes.FLOAT, allowNull: false },
    neededByDate: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.STRING(255), allowNull: true },
    checkStatus: { type: DataTypes.STRING(20), allowNull: true },
    checkAvailable: { type: DataTypes.FLOAT, allowNull: true },
    checkMill: { type: DataTypes.FLOAT, allowNull: true },
    checkIncoming: { type: DataTypes.FLOAT, allowNull: true },
    checkAtCoating: { type: DataTypes.FLOAT, allowNull: true },
    // Other open plans of an earlier (or the same) start date wanting the
    // same item/store/colour/length, not yet requested -- a warning only.
    checkCompeting: { type: DataTypes.FLOAT, allowNull: true },
    // Earliest ETA of the open POs counted in checkIncoming; a date after
    // the plan's start is flagged as late.
    checkIncomingEta: { type: DataTypes.DATEONLY, allowNull: true },
    reservationHeaderId: { type: DataTypes.INTEGER, allowNull: true },
    reservationItemId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProjectPlanItems',
    timestamps: true,
});
