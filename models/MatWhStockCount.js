// backend/models/MatWhStockCount.js
// IIT_Petra.matWhStockCounts -- one physical stock count (جرد) of a store,
// optionally narrowed to one category and/or zone. Its lines
// (MatWhStockCountLine.js) are the count sheet; approving the count is the
// real stock event -- every non-zero variance posts one 'stock_count_adjust'
// ledger movement (services/matWhStockCount.js). Also the way a store gets
// its starting stock: count a store with no history, every counted qty is
// a positive variance against a system balance of 0.
//
// Blind count by design: counters (.stock_count) never see the system qty
// or variance -- routes/materialsWarehouseStockCount.js strips them from
// every response unless the caller holds .stock_count_approve.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStockCount = sequelizeUtf8.define('MatWhStockCount', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // System-generated, SC-YYYY-#### -- see nextCountNo in the service.
    countNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // Optional scope filters, null = whole store. Recorded so the sheet's
    // scope is still visible after the fact.
    scopeCategory: { type: DataTypes.STRING(100), allowNull: true },
    scopeZone: { type: DataTypes.STRING(50), allowNull: true },
    // counting (lines open for entry) -> submitted (waiting for review)
    // -> approved (adjustments posted) / rejected (nothing posted).
    // submitted -> counting again via "recount selected lines".
    // counting -> cancelled by its creator/an approver.
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'counting' },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
    submittedBy: { type: DataTypes.INTEGER, allowNull: true },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    decidedBy: { type: DataTypes.INTEGER, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNotes: { type: DataTypes.STRING(500), allowNull: true },
}, {
    tableName: 'matWhStockCounts',
    timestamps: true,
});
