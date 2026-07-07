//backend/models/instOrderSteps.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrderSteps = sequelize2.define("InstOrderSteps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    instOrderItemId: DataTypes.INTEGER,
    instStepId: DataTypes.INTEGER,
    stepOrder: DataTypes.INTEGER,
    status: DataTypes.STRING,
}, {
    tableName: "instOrderSteps",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: "updatedAt"
});
