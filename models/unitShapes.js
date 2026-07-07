// backend/models/unitShapes.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const UnitShape = sequelize2.define('UnitShape', {
    unitShapeId: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    descEn: { type: DataTypes.STRING, allowNull: false },
    descAr: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'unitShapes',
    timestamps: true,
});

export default UnitShape;
