// backend/models/instTeamLocations.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstTeamLocations = sequelize2.define('InstTeamLocations', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    team_id: { type: DataTypes.INTEGER, allowNull: false },
    latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: false },
    ping_time: { type: DataTypes.DATE, allowNull: false }
}, {
    tableName: 'instTeamLocations',
    timestamps: false
});
