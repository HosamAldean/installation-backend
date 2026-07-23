// backend/models/HrAttendanceCorrectionRow.js
// One day's correction (day/date + entry time + exit time + notes) on an
// HrAttendanceCorrectionRequest -- the paper form's repeatable table.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrAttendanceCorrectionRow = sequelizeUtf8.define('HrAttendanceCorrectionRow', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requestId: { type: DataTypes.BIGINT, allowNull: false },
    dayDate: { type: DataTypes.DATEONLY, allowNull: false },
    entryTime: { type: DataTypes.STRING(5), allowNull: true },
    exitTime: { type: DataTypes.STRING(5), allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
}, {
    tableName: 'HrAttendanceCorrectionRows',
    timestamps: false,
});
