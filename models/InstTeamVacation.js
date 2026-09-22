// backend/models/InstTeamVacation.js
// Marks a team as unavailable (on vacation) for a specific calendar day, for
// the Schedule page's team roster. Genuinely new concept with no legacy
// Access/ERP equivalent -- sequelizeUtf8, same as InstOrderComponent.js.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const InstTeamVacation = sequelizeUtf8.define('InstTeamVacation', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    teamId: { type: DataTypes.INTEGER, allowNull: false },
    vacationDate: { type: DataTypes.DATEONLY, allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'InstTeamVacations',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['teamId', 'vacationDate'] },
    ],
});
