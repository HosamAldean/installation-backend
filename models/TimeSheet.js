// backend/models/TimeSheet.js
// IIT_Petra.timeSheet — sales-team time tracking, tied to a project
// and/or offer (919 live rows). See Migration Blueprint §07 "Offers"
// (timesheets listed as its own page). Verified against the live schema
// (SHOW COLUMNS), not guessed.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const TimeSheet = sequelize2PetraErp.define('TimeSheet', {
    timeSheetId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    timeSheetDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    timeSheetType: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    timeSheetTaskDesc: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    timeSheetStartTime: { type: DataTypes.DATE, allowNull: false },
    timeSheetEndTime: { type: DataTypes.DATE, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    assignToId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expectedDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    taskStatus: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
}, {
    tableName: 'timeSheet',
    timestamps: false,
});

export default TimeSheet;
