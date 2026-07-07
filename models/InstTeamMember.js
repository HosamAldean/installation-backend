// backend/models/InstTeamMember.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';
import { InstTeams } from './InstTeams.js';

export const InstTeamMember = sequelize2.define('InstTeamMember', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    team_id: { type: DataTypes.BIGINT, allowNull: false, references: { model: InstTeams, key: 'id' } },
    emp_no: { type: DataTypes.STRING, allowNull: false },
    assigned_at: { type: DataTypes.DATE, allowNull: true },
    is_leader: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
    tableName: 'instTeamMembers',
    timestamps: true,
});

// Associations
InstTeamMember.belongsTo(InstTeams, { foreignKey: 'team_id' });
