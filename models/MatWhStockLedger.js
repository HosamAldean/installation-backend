// backend/models/MatWhStockLedger.js
// IIT_Petra.matWhStockLedger -- WH.3. The single unified movement ledger
// (Alpha's InvDailyDF pattern, Alpha Warehouse Analysis report §10/§04):
// every movement -- receipt, transfer, issue, return, external-send/
// receive, write-off -- is one row shape here, not a table per type.
// Confirming a reservation is deliberately NOT posted here (it doesn't move
// physical stock, only earmarks it -- see MatWhReservationItem.js and Stock
// House's own precedent, §07); ISSUING a confirmed reservation line does
// post here (docType 'issue') -- that's the real physical hand-over, see
// services/matWhReservations.js's issueReservationLine.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStockLedger = sequelizeUtf8.define('MatWhStockLedger', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    // Null means either "not a color-tracked item" or "mill-finish/raw" --
    // the same reservation/PO-item convention this ledger otherwise never
    // recorded until Phase 3 of the 2026-09-22 capability audit. Every
    // read helper below treats an OMITTED color argument as "don't filter
    // by color at all" (pooled total, today's exact behavior) -- passing
    // an explicit null means "raw/mill only," a genuinely narrower filter.
    // Never conflate the two.
    color: { type: DataTypes.STRING(50), allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false }, // always positive; direction carries the sign meaning
    direction: { type: DataTypes.STRING(3), allowNull: false }, // 'in' | 'out'
    // receipt, transfer_in, transfer_out, issue, return, external_send,
    // external_receive, writeoff
    docType: { type: DataTypes.STRING(30), allowNull: false },
    refType: { type: DataTypes.STRING(30), allowNull: true }, // e.g. 'goods_receipt', 'external_processing'
    refId: { type: DataTypes.INTEGER, allowNull: true },
    unitCost: { type: DataTypes.FLOAT, allowNull: true },
    totalCost: { type: DataTypes.FLOAT, allowNull: true },
    movementDate: { type: DataTypes.DATE, allowNull: false },
    performedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhStockLedger',
    timestamps: true,
});
