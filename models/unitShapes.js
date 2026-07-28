// backend/models/unitShapes.js
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const UnitShape = sequelize2PetraErp.define('UnitShape', {
    unitShapeId: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    descEn: { type: DataTypes.STRING, allowNull: false },
    descAr: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'unitShapes',
    // Was `timestamps: true`, but the live table has no createdAt/updatedAt
    // columns -- any ORM-method query (findAll, create, etc., not raw SQL)
    // threw ER_BAD_FIELD_ERROR ("Unknown column 'createdAt'"). Found while
    // verifying the Arabic-text fix on this same model.
    timestamps: false,
});

export default UnitShape;
