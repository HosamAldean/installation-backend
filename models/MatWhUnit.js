// backend/models/MatWhUnit.js
// IIT_Petra.matWhUnits -- unit-of-measure lookup for the Materials
// Warehouse item catalog (matWhItems.baseUnit/altUnit). Same reasoning as
// MatWhCategory: those two columns were free-text copied straight from
// PetraStock's own unit1/unit2 columns; this is the managed list they now
// pick from, still just storing this row's unitCode string.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhUnit = sequelizeUtf8.define('MatWhUnit', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    unitCode: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    unitName: { type: DataTypes.STRING(50), allowNull: false },
    unitNameAr: { type: DataTypes.STRING(50), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhUnits',
    timestamps: false,
});
