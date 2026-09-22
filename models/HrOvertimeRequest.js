// backend/models/HrOvertimeRequest.js
// Digitized version of HR form 10-25 (additional/overtime work request).
// The paper form's employee table (Emp# / Name / Hours / Notes, one row
// per employee) was dropped per explicit direction -- self-service only,
// one request per submitter for their own overtime, same shape as Leave/
// Attendance/Transport, with a single `hours` field replacing the old
// per-row hours column. See HrOvertimeEmployee.js (now unused) for the
// prior multi-employee version.
// Unlike Leave/Attendance/Transport (2-stage: manager -> HR), this form's
// paper approval line is manager -> company management -- mapped here to a
// 3rd stage, GM (see utils/supervisorLookup.js's isGeneralManager),
// inserted between manager and HR per explicit direction.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrOvertimeRequest = sequelizeUtf8.define('HrOvertimeRequest', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requesterUserId: { type: DataTypes.INTEGER, allowNull: false },
    requesterEmpNo: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    // "طبيعة الأعمال الإضافية" -- free-text description of the extra work.
    workNature: { type: DataTypes.TEXT, allowNull: true },
    // "نوع العمل الإضافي" checkbox pair on the form: weekday overtime vs.
    // holiday/Eid-day overtime.
    otType: { type: DataTypes.ENUM('weekday', 'holiday'), allowNull: false },
    // "عدد الساعات" -- single value now that this is one request per
    // employee rather than a per-row table.
    hours: { type: DataTypes.FLOAT, allowNull: true },
    status: {
        type: DataTypes.ENUM(
            'pending_manager',
            'pending_gm',
            'pending_hr',
            'approved',
            'rejected',
            'canceled',
        ),
        allowNull: false,
        defaultValue: 'pending_manager',
    },
    managerApproverEmpNo: { type: DataTypes.INTEGER, allowNull: true },
    managerDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    managerDecidedAt: { type: DataTypes.DATE, allowNull: true },
    managerNote: { type: DataTypes.TEXT, allowNull: true },
    // Always the 'gm' role account today (a single seat) -- stored as the
    // actual deciding userId rather than assumed, same reasoning as every
    // other stage here, in case that ever changes.
    gmApproverUserId: { type: DataTypes.INTEGER, allowNull: true },
    gmDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    gmDecidedAt: { type: DataTypes.DATE, allowNull: true },
    gmNote: { type: DataTypes.TEXT, allowNull: true },
    hrReviewerUserId: { type: DataTypes.INTEGER, allowNull: true },
    hrDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    hrDecidedAt: { type: DataTypes.DATE, allowNull: true },
    hrNote: { type: DataTypes.TEXT, allowNull: true },
    // See HrLeaveRequest.js's exportedAt/canceledAt for the rationale.
    exportedAt: { type: DataTypes.DATE, allowNull: true },
    canceledAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'HrOvertimeRequests',
    timestamps: true,
});
