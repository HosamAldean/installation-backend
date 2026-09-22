// backend/models/InstOrderComponent.js
// Server-persisted record of one material (a Stock row in the main
// warehouse) confirmed installed or flagged with an issue on a unit --
// backs the Installation Order Management page, which replaces the old
// fixed instSteps checklist with a completion rate computed from real
// warehouse allocation (Stock.UNO) instead of an abstract step list. One
// row per (instOrderItemId, barcode); status is mutable -- an already-
// installed material can later be re-flagged as an issue (confirmed
// product decision), so this is a current-state row, not an append-only
// log. A wrong confirmation with no real issue is removed (DELETE) rather
// than edited into a fake "resolved" state.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const InstOrderComponent = sequelizeUtf8.define('InstOrderComponent', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instOrderItemId: { type: DataTypes.INTEGER, allowNull: false },
    // Short, explicit length -- the default STRING(255) in utf8mb4 exceeds
    // this (older-row-format) server's 767-byte max index key length when
    // combined with instOrderItemId in the unique index below. Real
    // barcode values here are short numeric strings (~9 digits).
    barcode: { type: DataTypes.STRING(64), allowNull: false },
    productName: { type: DataTypes.STRING, allowNull: true },
    productionNo: { type: DataTypes.STRING, allowNull: true },
    // 'Pending' means the barcode has been scanned but not yet confirmed
    // installed or flagged -- the row exists purely to record WHEN that
    // first scan happened (see registerMaterialScan in
    // services/instOrderComponents.js), independent of any other material
    // on the same unit.
    status: {
        type: DataTypes.ENUM('Pending', 'Installed', 'Issue'),
        allowNull: false,
        defaultValue: 'Pending',
    },
    // Required by the route layer when status is 'Issue', optional for
    // 'Installed' -- not enforced at the DB level since the same column
    // serves both.
    note: { type: DataTypes.TEXT, allowNull: true },
    mediaUrl: { type: DataTypes.STRING, allowNull: true },
    mediaType: { type: DataTypes.ENUM('image', 'video'), allowNull: true },
    // Null while status is 'Pending' -- nobody has confirmed anything yet,
    // just scanned it.
    confirmedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    confirmedByEmpNo: { type: DataTypes.STRING, allowNull: true },
    // Pause/resume, for excluding idle time from this material's own
    // installation duration. onHold + pausedAt describe the CURRENT pause
    // (pausedAt is when it started, null while running); pausedSeconds is
    // the running total of every PAST completed pause on this item, added
    // to on each resume. holdReason is required to pause and is kept after
    // resuming as a record of why, not cleared.
    onHold: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    holdReason: { type: DataTypes.TEXT, allowNull: true },
    pausedAt: { type: DataTypes.DATE, allowNull: true },
    pausedSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'InstOrderComponents',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['instOrderItemId', 'barcode'] },
    ],
});
