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
            'sick',
            'work_injury',
        ),
        allowNull: true,
    },
    reason: { type: DataTypes.TEXT, allowNull: true },
    // Required (enforced in routes/hrRequests.js) for leaveType 'sick' and
    // 'condolence_occasional' (sick note / death certificate) -- optional
    // for every other type. Single file, mirrors the avatar-upload pattern
    // in routes/upload.js (image or PDF, not a photo/video capture pair
    // like the installation-order attachments).
    attachmentUrl: { type: DataTypes.STRING, allowNull: true },
    attachmentMimeType: { type: DataTypes.STRING, allowNull: true },
    status: {
        type: DataTypes.ENUM('pending_manager', 'pending_hr', 'approved', 'rejected', 'canceled'),
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
    // Set when this row was last included in a report export (CSV or
    // PDF) -- lets the report default to "not yet exported" so a fresh
    // export naturally only grabs new records instead of re-exporting
    // everything every time. See scripts/add-hr-export-tracking.js.
    exportedAt: { type: DataTypes.DATE, allowNull: true },
    // Set when the requester withdraws their own request via the
    // self-service cancel button -- see PUT.../:id cancel handling in
    // routes/hrRequests.js. Kept as a status change rather than a DELETE
    // so a canceled request stays on record instead of disappearing.
    canceledAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'HrLeaveRequests',
    timestamps: true,
});
