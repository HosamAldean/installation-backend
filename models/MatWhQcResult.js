// backend/models/MatWhQcResult.js
// IIT_Petra.matWhQcResults -- categorized QC findings per received line,
// sitting alongside the plain accepted/loss/rejected totals on
// matWhGoodsReceiptItems (doesn't replace them). Deferred out of WH.1
// because it FKs to goodsReceiptItemId, which didn't exist until WH.2. See
// the Alpha Warehouse Analysis report §10.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhQcResult = sequelizeUtf8.define('MatWhQcResult', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    goodsReceiptItemId: { type: DataTypes.INTEGER, allowNull: false },
    qcCategoryId: { type: DataTypes.INTEGER, allowNull: false },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'matWhQcResults',
    timestamps: true,
});
