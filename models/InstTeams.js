// backend/models/InstTeams.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstTeams = sequelize2.define('InstTeams', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(191), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true }
}, {
    tableName: 'InstTeams',
    timestamps: false
});
