// backend/models/MatWhItemCost.js
// IIT_Petra.matWhItemCost -- WH.4. Running valuation per item+store. Both
// costing methods are computed and stored on every receipt (Alpha
// Warehouse Analysis report §10) so the choice isn't locked into the
// schema -- costMethod picks which one populates currentCost, the figure
// valuation/reporting actually reads. Went live on 'lastCost' (Alpha's own
// behavior, §05); switched to 'weightedAvg' on 2026-10-22 at the user's
// decision -- every existing row was converted (backup in C:\IA\backups\),
// and new rows default to it so purchases and coating cost blend in.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhItemCost = sequelizeUtf8.define('MatWhItemCost', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    lastCost: { type: DataTypes.FLOAT, allowNull: true },
    weightedAvgCost: { type: DataTypes.FLOAT, allowNull: true },
    costMethod: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'weightedAvg' }, // lastCost, weightedAvg
    currentCost: { type: DataTypes.FLOAT, allowNull: true },
    onHandQty: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    lastUpdated: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'matWhItemCost',
    timestamps: true,
    indexes: [
        { unique: true, fields: ['itemId', 'storeId'] },
    ],
});
