// backend/models/MatWhReservationHeader.js
// IIT_Petra.matWhReservationHeaders -- one reservation per project, holding
// one or more MatWhReservationItem lines. Replaces the old flat
// MatWhReservation (single item+store+qty row, no project identity beyond
// a bare optional projectId) per direct request: a real reservation covers
// multiple items for one project, with the project's own name/manager
// shown up front, not just its numeric id.
//
// projectNo/projectName/projectManager are a snapshot taken from
// IIT_Petra.project + .user at reservation time (same pattern as
// mainStock.js's projMgr lookup) -- not live-joined on every read, so a
// later change to the project's manager doesn't silently rewrite history
// on an already-made reservation.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhReservationHeader = sequelizeUtf8.define('MatWhReservationHeader', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    reservationNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: true },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    projectManager: { type: DataTypes.STRING(255), allowNull: true },
    // Free-text technician/site-requester name (WM 10-21 "اسم الفني") --
    // not a system user reference. The person asking for material on-site
    // is frequently not the one entering the reservation (createdBy is
    // whoever's logged in doing the data entry), and often isn't a system
    // user at all, so this is a plain snapshot string, same treatment as
    // projectManager above.
    requestedByName: { type: DataTypes.STRING(255), allowNull: true },
    // System-set at creation, not user-entered -- when the reservation was
    // made.
    reservationDate: { type: DataTypes.DATE, allowNull: false },
    // User-entered -- the date this material is needed/held for, distinct
    // from reservationDate. Matches Alpha's Invt_ReservedStockHF.VouDate
    // vs. Invt_ReservedStockDF.ResUpToDate split (per-line has its own
    // needed-by date too, see MatWhReservationItem.itemNeededByDate).
    reservedUntilDate: { type: DataTypes.DATEONLY, allowNull: true },
    // draft (technician still adding items) -> submitted (sent to each
    // item's own store -- lines are then confirmed/rejected independently
    // per store, not as one whole-reservation decision, see
    // services/matWhReservations.js) -> confirmed (every line decided, at
    // least one confirmed/partially_confirmed and not yet issued) ->
    // issued (every non-rejected line issued) / released (every line
    // released) / rejected (every line rejected -- nothing was ever
    // actually reserved).
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
    confirmedBy: { type: DataTypes.INTEGER, allowNull: true },
    confirmedDate: { type: DataTypes.DATE, allowNull: true },
    // Set only when this reservation has been transferred to a different
    // project (see routes' /transfer action) -- a one-step-back snapshot of
    // what it was transferred FROM, not a full history table, same
    // convention as MatWhPurchaseOrder's own storekeeperConfirmedBy/
    // managerConfirmedBy fields. A second transfer overwrites these with
    // the project it was just transferred FROM (the one before that is
    // lost, by design -- one step of undo-context is enough for this).
    previousProjectId: { type: DataTypes.INTEGER, allowNull: true },
    previousProjectNo: { type: DataTypes.STRING(50), allowNull: true },
    previousProjectName: { type: DataTypes.STRING(255), allowNull: true },
    transferredBy: { type: DataTypes.INTEGER, allowNull: true },
    transferredDate: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'matWhReservationHeaders',
    timestamps: true,
});
