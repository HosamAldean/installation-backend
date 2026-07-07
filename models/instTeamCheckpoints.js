// backend/models/instTeamCheckpoints.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstTeamCheckpoints = sequelize2.define('InstTeamCheckpoints', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    team_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    order_id: { type: DataTypes.INTEGER, allowNull: true },
    // Matches the live DB enum — only 'inProject'/'outProject' are written
    // by current code (see followUp.js /team/checkpoint), but 'outCompany'/
    // 'inCompany' still exist on historical rows.
    checkpoint_type: { type: DataTypes.ENUM('outCompany', 'inProject', 'outProject', 'inCompany'), allowNull: false },
    latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: false },
    longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'instTeamCheckpoints',
    timestamps: true, // real columns are createdAt/updatedAt, not created_at
});
