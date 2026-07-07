// backend/models/FollowUpNotes.js
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const FollowUpNotes = sequelizeUtf8.define('FollowUpNotes', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    // References instOrderStepUpdates.id (the worker-reported issue this
    // follow-up note is attached to) — that table lives on a different
    // Sequelize connection (sequelize2), so this is a plain reference
    // resolved via application-level joins, not a Sequelize association.
    issueId: { type: DataTypes.BIGINT, allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: false },
    createdBy: { type: DataTypes.INTEGER, allowNull: false },
    resolved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    resolvedBy: { type: DataTypes.INTEGER, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'FollowUpNotes',
    timestamps: false,
});
