// backend/models/MatWhStockCountLine.js
// IIT_Petra.matWhStockCountLines -- one line of a MatWhStockCount's sheet:
// one store+item(+color+length) combination, at the same granularity every
// ledger query uses (services/matWhLedger.js's getPhysicalBalance).
//
// systemQty is snapshotted at the moment the line is COUNTED, not when the
// sheet was created -- so the store never has to freeze. varianceQty =
// countedQty - systemQty, and approval posts exactly that delta: any
// movement before the count is already inside systemQty, any movement
// after it is a separate ledger row the adjustment doesn't touch.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStockCountLine = sequelizeUtf8.define('MatWhStockCountLine', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    stockCountId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    // Same convention as the ledger: null = not color-tracked or mill
    // finish (normalizeColor folds 'MILL' into null before storing).
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    // Location snapshot from matWhItemStores at sheet creation, so the
    // sheet can be sorted/printed by where to walk.
    zone: { type: DataTypes.STRING(50), allowNull: true },
    locationColumn: { type: DataTypes.STRING(50), allowNull: true },
    locationRow: { type: DataTypes.STRING(50), allowNull: true },
    // null until counted. Hidden from counters (blind count).
    systemQty: { type: DataTypes.FLOAT, allowNull: true },
    countedQty: { type: DataTypes.FLOAT, allowNull: true },
    varianceQty: { type: DataTypes.FLOAT, allowNull: true },
    countedBy: { type: DataTypes.INTEGER, allowNull: true },
    countedAt: { type: DataTypes.DATE, allowNull: true },
    // Optional, approver-entered: cost for a positive variance on an item
    // with no known cost yet (typically a store's first count = its
    // opening stock). Fed to applyReceiptCost on approval.
    unitCost: { type: DataTypes.FLOAT, allowNull: true },
    // Found on the shelf but not on the generated sheet.
    isExtra: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Set by "recount selected lines" -- the count goes back to counting
    // and only these lines reopen.
    needsRecount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ledgerEntryId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhStockCountLines',
    timestamps: true,
    indexes: [{ fields: ['stockCountId'] }],
});
