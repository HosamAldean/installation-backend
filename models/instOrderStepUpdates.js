// backend/models/instOrderStepUpdates.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrderStepUpdates = sequelize2.define('InstOrderStepUpdates', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instOrderStepId: { type: DataTypes.BIGINT, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'done', 'problem'), allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    problem_note: { type: DataTypes.TEXT, allowNull: true },
    image_before: { type: DataTypes.STRING(255), allowNull: true },
    image_after: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'instOrderStepUpdates',
    timestamps: false
});
