// backend/models/Item.js
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';


export const Item = sequelize.define('Item', {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    code: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 }
}, {
    tableName: 'items',
    timestamps: true
});