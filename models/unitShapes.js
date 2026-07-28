// backend/models/unitShapes.js
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const UnitShape = sequelize2PetraErp.define('UnitShape', {
    unitShapeId: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    descEn: { type: DataTypes.STRING, allowNull: false },
    descAr: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'unitShapes',
    timestamps: true,
});

export default UnitShape;
