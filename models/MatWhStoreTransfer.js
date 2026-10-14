// backend/models/MatWhStoreTransfer.js
// IIT_Petra.matWhStoreTransfers -- one store-to-store stock transfer
// (scope WH.3: internal transfers are transfer_out / transfer_in movements
// on the single stock ledger, not a stock table of their own). Its lines
// live in MatWhStoreTransferLine.js; the logic in
// services/matWhStoreTransfer.js.
//
// Two steps by design: SEND posts transfer_out at the source store (stock
// leaves it and is "in transit"), RECEIVE posts transfer_in at the
// destination once that store confirms what actually arrived -- possibly
// over several receives. A shortage stays open (partially_received) until
// it arrives or is written off; it is never silently returned to the
// source. No approval step before send -- the receiving store's
// confirmation is the control.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStoreTransfer = sequelizeUtf8.define('MatWhStoreTransfer', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // System-generated, TR-YYYY-#### -- see nextTransferNo in the service.
    transferNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    fromStoreId: { type: DataTypes.INTEGER, allowNull: false },
    toStoreId: { type: DataTypes.INTEGER, allowNull: false },
    // draft (lines editable) -> sent (out posted) -> partially_received /
    // received (in posted). draft -> cancelled (nothing posted). No cancel
    // after send: the stock has already left the source store.
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
    sentBy: { type: DataTypes.INTEGER, allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    receivedBy: { type: DataTypes.INTEGER, allowNull: true },
    lastReceivedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'matWhStoreTransfers',
    timestamps: true,
    indexes: [{ fields: ['status'] }, { fields: ['fromStoreId'] }, { fields: ['toStoreId'] }],
});
