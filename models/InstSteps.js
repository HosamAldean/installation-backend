// backend/models/InstSteps.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstSteps = sequelize2.define('InstSteps', {
    instStepId: { type: DataTypes.INTEGER, primaryKey: true },
    unitTypeId: DataTypes.INTEGER,
    stepName: DataTypes.STRING,
    stepNumber: DataTypes.INTEGER,
    description: DataTypes.STRING,
    standardTime: DataTypes.FLOAT,
    isActive: DataTypes.TINYINT
}, {
    tableName: "instSteps",
    timestamps: false
});
