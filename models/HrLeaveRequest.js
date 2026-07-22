// backend/models/HrLeaveRequest.js
// Digitized version of HR form 10-20 (leave / personal departure request).
// New, native table (not a port of anything in PayEmp/Pay_Job) -- approval
// routing uses PayEmp.Supervisor_No (read-only, looked up at request time
// in routes/hrRequests.js, not stored here) rather than a stored manager
// reference, so a later change to someone's supervisor doesn't strand old
// requests pointing at a stale approver.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrLeaveRequest = sequelizeUtf8.define('HrLeaveRequest', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requesterUserId: { type: DataTypes.INTEGER, allowNull: false },
    requesterEmpNo: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.ENUM('departure', 'leave'), allowNull: false },
    fromTime: { type: DataTypes.STRING(5), allowNull: true },
    toTime: { type: DataTypes.STRING(5), allowNull: true },
    fromDate: { type: DataTypes.DATEONLY, allowNull: true },
    toDate: { type: DataTypes.DATEONLY, allowNull: true },
    leaveType: {
        type: DataTypes.ENUM(
            'annual',
            'absence_by_request',
            'condolence_occasional',
            'maternity_paternity',
            'hajj',
            'study',
        ),
        allowNull: true,
    },
    reason: { type: DataTypes.TEXT, allowNull: true },
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
    tableName: 'HrLeaveRequests',
    timestamps: true,
});
