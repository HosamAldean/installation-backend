// backend/models/InstOrderDetails.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrderDetails = sequelize2.define('InstOrderDetails', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instOrderId: { type: DataTypes.BIGINT, allowNull: false },
    masterRowId: { type: DataTypes.BIGINT, allowNull: true },
    unitCount: { type: DataTypes.INTEGER, allowNull: true },
    width: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    height: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    glassType: { type: DataTypes.STRING, allowNull: true },
    unitShapeId: { type: DataTypes.BIGINT, allowNull: true }
}, {
    tableName: 'instOrderDetails',
    timestamps: false
});
