// backend/models/HrAttendanceCorrectionRequest.js
// Digitized version of HR form 10-26 (attendance correction request).
// Header row; the day-by-day corrections themselves live in
// HrAttendanceCorrectionRow (see that file), associated below since both
// are on the same sequelizeUtf8 connection.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrAttendanceCorrectionRequest = sequelizeUtf8.define('HrAttendanceCorrectionRequest', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requesterUserId: { type: DataTypes.INTEGER, allowNull: false },
    requesterEmpNo: { type: DataTypes.INTEGER, allowNull: false },
    status: {
        type: DataTypes.ENUM('pending_manager', 'pending_hr', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending_manager',
    },
    managerApproverEmpNo: { type: DataTypes.INTEGER, allowNull: true },
    managerDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    managerDecidedAt: { type: DataTypes.DATE, allowNull: true },
    managerNote: { type: DataTypes.TEXT, allowNull: true },
    hrReviewerUserId: { type: DataTypes.INTEGER, allowNull: true },
    hrDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    hrDecidedAt: { type: DataTypes.DATE, allowNull: true },
    hrNote: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'HrAttendanceCorrectionRequests',
    timestamps: true,
});
