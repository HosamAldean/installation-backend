// backend/models/MatWhWriteoffReport.js
// IIT_Petra.matWhWriteoffReports -- WM 10-42, the follow-up record of an
// APPROVED write-off request (MatWhWriteoffRequest, WM 10-41): what was
// actually destroyed (see MatWhWriteoffReportItem.qtyDestroyed, which can
// differ from the request's own qtyRequested), witnessed by a committee
// member sign-off, then acknowledged by upper management. One report per
// request (1:1 -- writeoffRequestId is unique here).
//
// Creating this report is the actual physical-stock event -- unlike the
// request, which never touches matWhStockLedger, filing a report posts a
// real 'out'/'writeoff' movement per line immediately (see
// services/matWhWriteoff.js's createWriteoffReport). Committee sign-off
// and upper-management acknowledgment are witness/awareness metadata
// layered on afterward, not gates on whether the ledger already moved --
// by the time a report exists, the material is already gone.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhWriteoffReport = sequelizeUtf8.define('MatWhWriteoffReport', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    writeoffRequestId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    reportNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    // User-entered -- when the material was actually destroyed, which can
    // predate when the report is typed up.
    destroyedDate: { type: DataTypes.DATEONLY, allowNull: false },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
    // Committee member witnessing/confirming the destruction happened as
    // described -- a single sign-off field, a deliberate simplification of
    // the paper form's likely multi-signature committee block (same
    // simplification this codebase already makes for HR request approvals,
    // one approverEmpNo per stage rather than a signature list).
    committeeMemberBy: { type: DataTypes.INTEGER, allowNull: true },
    committeeSignedDate: { type: DataTypes.DATE, allowNull: true },
    committeeNotes: { type: DataTypes.STRING(500), allowNull: true },
    // "اطلاع الإدارة العليا" -- upper management's acknowledgment that
    // they've seen this report, distinct from and lighter than the
    // approve/reject DECISION already made back on the request.
    upperManagementAckBy: { type: DataTypes.INTEGER, allowNull: true },
    upperManagementAckDate: { type: DataTypes.DATE, allowNull: true },
    // recorded (created, ledger already posted) -> committee_signed ->
    // acknowledged.
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'recorded' },
}, {
    tableName: 'matWhWriteoffReports',
    timestamps: true,
});
