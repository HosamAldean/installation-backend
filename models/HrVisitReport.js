// backend/models/HrVisitReport.js
// Digitized version of HR form 10-35 (daily visits report, تقرير الزيارات
// اليومي). Header row: the visit day plus when the employee left and came
// back to the company; the visits themselves live in HrVisitReportRow
// (the paper form's repeatable table), associated in models/index.js.
// Only for the work places in VISIT_REPORT_WORK_PLACES (utils/hrScope.js).
// Approval line is the paper form's: manager -> HR audit (pending_hr),
// with the same factory-manager stage as the other 4 forms.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrVisitReport = sequelizeUtf8.define('HrVisitReport', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requesterUserId: { type: DataTypes.INTEGER, allowNull: false },
    requesterEmpNo: { type: DataTypes.INTEGER, allowNull: false },
    // "التاريخ" -- the day the visits happened ("اليوم" is derived from it).
    visitDate: { type: DataTypes.DATEONLY, allowNull: false },
    // "وقت المغادرة من الشركة" / "وقت العودة إلى الشركة", HH:MM. Optional --
    // a visit can start from home or end the day off-site.
    leftCompanyTime: { type: DataTypes.STRING(5), allowNull: true },
    returnedTime: { type: DataTypes.STRING(5), allowNull: true },
    // The form's note: the report must reach HR within 48 hours of the
    // visit, otherwise the whole day is deducted. Set at submission (see
    // isVisitReportLate in routes/hrRequests.js) so HR sees it; deciding
    // the deduction stays with HR.
    submittedLate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
        type: DataTypes.ENUM('pending_manager', 'pending_factory_mgr', 'pending_hr', 'approved', 'rejected', 'canceled'),
        allowNull: false,
        defaultValue: 'pending_manager',
    },
    managerApproverEmpNo: { type: DataTypes.INTEGER, allowNull: true },
    managerDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    managerDecidedAt: { type: DataTypes.DATE, allowNull: true },
    managerNote: { type: DataTypes.TEXT, allowNull: true },
    // Factory-manager stage (pending_factory_mgr) -- see
    // needsFactoryManagerStep in utils/hrScope.js. Null when skipped.
    factoryMgrApproverEmpNo: { type: DataTypes.INTEGER, allowNull: true },
    factoryMgrDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    factoryMgrDecidedAt: { type: DataTypes.DATE, allowNull: true },
    factoryMgrNote: { type: DataTypes.TEXT, allowNull: true },
    hrReviewerUserId: { type: DataTypes.INTEGER, allowNull: true },
    hrDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    hrDecidedAt: { type: DataTypes.DATE, allowNull: true },
    hrNote: { type: DataTypes.TEXT, allowNull: true },
    // See HrLeaveRequest.js's exportedAt/canceledAt for the rationale.
    exportedAt: { type: DataTypes.DATE, allowNull: true },
    canceledAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'HrVisitReports',
    timestamps: true,
});
