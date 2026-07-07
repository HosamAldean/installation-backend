// backend/models/instOrderHolds.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrderHolds = sequelize2.define('InstOrderHolds', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instOrderId: { type: DataTypes.BIGINT, allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: false },
    holdBy: { type: DataTypes.INTEGER, allowNull: false },
    holdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    tableName: 'instOrderHolds',
    timestamps: false
});
