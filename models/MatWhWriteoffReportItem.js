// backend/models/MatWhWriteoffReportItem.js
// IIT_Petra.matWhWriteoffReportItems -- one line of a MatWhWriteoffReport:
// what was actually destroyed against one specific requested line.
// storeId/itemId are denormalized from the parent request's line rather
// than looked up through writeoffRequestItemId on every read -- needed
// directly at ledger-post time (services/matWhWriteoff.js).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhWriteoffReportItem = sequelizeUtf8.define('MatWhWriteoffReportItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    writeoffReportId: { type: DataTypes.INTEGER, allowNull: false },
    writeoffRequestItemId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // What actually got destroyed -- can be less than (or in principle
    // more than, if more turned out unusable on inspection) the request
    // line's own qtyRequested.
    qtyDestroyed: { type: DataTypes.FLOAT, allowNull: false },
    // Ledger row this line posted -- kept for a direct link back from the
    // report line to its own stock movement, same convention as
    // MatWhReservationItem.purchaseOrderId pointing at what it raised.
    ledgerEntryId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhWriteoffReportItems',
    timestamps: true,
});
