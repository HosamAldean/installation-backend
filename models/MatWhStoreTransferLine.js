// backend/models/MatWhStoreTransferLine.js
// IIT_Petra.matWhStoreTransferLines -- one item/color/length moved by a
// store transfer (MatWhStoreTransfer.js). In transit = qtySent - qtyReceived,
// derived here rather than stored on the ledger. Every receive posts its own
// transfer_in ledger row (refType 'store_transfer_line', refId = this line),
// so partial receives need no extra table.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStoreTransferLine = sequelizeUtf8.define('MatWhStoreTransferLine', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    storeTransferId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    // Same granularity as the ledger: color normalized (MILL -> null),
    // length a plain number or null.
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    // Planned qty while draft; becomes the qty actually sent at send.
    qtySent: { type: DataTypes.FLOAT, allowNull: false },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    // Source store's current cost snapshotted at send -- carried into the
    // destination store's cost on receive.
    unitCost: { type: DataTypes.FLOAT, allowNull: true },
    outLedgerEntryId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhStoreTransferLines',
    timestamps: true,
    indexes: [{ fields: ['storeTransferId'] }],
});
