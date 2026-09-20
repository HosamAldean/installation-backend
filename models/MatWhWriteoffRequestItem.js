// backend/models/MatWhWriteoffRequestItem.js
// IIT_Petra.matWhWriteoffRequestItems -- one line of a
// MatWhWriteoffRequest: the item and quantity proposed for write-off.
// qtyRequested is what's PROPOSED here -- the report stage
// (MatWhWriteoffReportItem.qtyDestroyed) records what actually got
// destroyed, which can differ (e.g. only part of a damaged batch turned
// out to be unusable once inspected).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhWriteoffRequestItem = sequelizeUtf8.define('MatWhWriteoffRequestItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    writeoffRequestId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    qtyRequested: { type: DataTypes.FLOAT, allowNull: false },
    // Optional per-line override/detail of the header's overall reason --
    // null means "same as the header reason".
    reason: { type: DataTypes.STRING(500), allowNull: true },
}, {
    tableName: 'matWhWriteoffRequestItems',
    timestamps: true,
});
