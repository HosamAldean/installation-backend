// backend/models/MatWhCategory.js
// IIT_Petra.matWhCategories -- item category lookup for the Materials
// Warehouse item catalog. Previously matWhItems.category was free-text
// (copied straight from PetraStock's own free-text `categ` column); this
// is the managed list it's meant to be picked from now, so a typo can't
// silently create a new, uncatalogued category. matWhItems.category
// itself stays a plain string column (storing this row's categoryCode) --
// not turned into a real FK, to avoid a bigger migration for what's still
// just a picklist.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhCategory = sequelizeUtf8.define('MatWhCategory', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    categoryCode: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    categoryName: { type: DataTypes.STRING(100), allowNull: false },
    categoryNameAr: { type: DataTypes.STRING(100), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhCategories',
    timestamps: false,
});
