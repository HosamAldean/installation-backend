// backend/models/MatWhWriteoffRequest.js
// IIT_Petra.matWhWriteoffRequests -- WM 10-41, the request stage of the
// Material Write-off feature: a storekeeper proposes writing off damaged/
// expired/obsolete stock (item(s), quantity, reason); upper management
// approves or rejects the REQUEST itself (whether a write-off should
// happen at all) -- the follow-up record of what was actually destroyed
// is a separate document, see MatWhWriteoffReport.js (WM 10-42).
//
// Not project-tied like MatWhReservationHeader -- a write-off is
// frequently general warehouse housekeeping (damaged-in-storage, expired,
// obsolete stock) with no project behind it, so projectId/projectNo/
// projectName are all optional here, unlike reservations where a project
// is mandatory.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhWriteoffRequest = sequelizeUtf8.define('MatWhWriteoffRequest', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    requestNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    projectNo: { type: DataTypes.STRING(50), allowNull: true },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    // Overall justification (damaged/expired/obsolete/etc.) -- a line can
    // still carry its own more specific reason, see
    // MatWhWriteoffRequestItem.reason.
    reason: { type: DataTypes.TEXT, allowNull: false },
    // System-set at creation, not user-entered -- when the request was
    // made (same convention as MatWhReservationHeader.reservationDate).
    requestDate: { type: DataTypes.DATE, allowNull: false },
    // draft (still adding items) -> submitted (sent to upper management)
    // -> approved / rejected (final decision, see decidedBy/decidedDate/
    // decisionNotes) -> reported (once its MatWhWriteoffReport is filed --
    // only reachable from 'approved', see services/matWhWriteoff.js).
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    requestedBy: { type: DataTypes.INTEGER, allowNull: true },
    decidedBy: { type: DataTypes.INTEGER, allowNull: true },
    decidedDate: { type: DataTypes.DATE, allowNull: true },
    decisionNotes: { type: DataTypes.STRING(500), allowNull: true },
}, {
    tableName: 'matWhWriteoffRequests',
    timestamps: true,
});
