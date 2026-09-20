// backend/models/MatWhExternalProcessing.js
// IIT_Petra.matWhExternalProcessing -- material sent to an outside
// processor (e.g. a coating company) and received back. Modeled after
// Stock House's MIX table (§07), generalized beyond coating specifically.
// Unlike reservations, this IS a real physical movement out of and back
// into the store, so both the send and the receive-back post to
// matWhStockLedger.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhExternalProcessing = sequelizeUtf8.define('MatWhExternalProcessing', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    processVendorId: { type: DataTypes.INTEGER, allowNull: true },
    qtySent: { type: DataTypes.FLOAT, allowNull: false },
    qtyReceived: { type: DataTypes.FLOAT, allowNull: true },
    sentDate: { type: DataTypes.DATE, allowNull: false },
    receivedDate: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sent' }, // sent, received
    sentBy: { type: DataTypes.INTEGER, allowNull: true },
    receivedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhExternalProcessing',
    timestamps: true,
});
