// backend/models/MatWhSubCategory.js
// IIT_Petra.matWhSubCategories -- item sub-category lookup, scoped to a
// parent MatWhCategory (see that model's own header). Same reasoning:
// matWhItems.subCategory was free-text copied from PetraStock's `scateg`
// column; this is the managed list it now picks from, matWhItems.
// subCategory itself still just stores this row's subCategoryCode string.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhSubCategory = sequelizeUtf8.define('MatWhSubCategory', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    categoryId: { type: DataTypes.INTEGER, allowNull: false },
    // NOT globally unique -- Alpha's own sub-category codes repeat across
    // different parent categories (e.g. "SHUCO"/"EA"/"KA" are real
    // sub-categories under BOTH the accessories (ACC) and aluminum (ALM)
    // top-level categories, verified live 2026-09-15). Unique only as a
    // (categoryId, subCategoryCode) pair -- see the composite index below.
    subCategoryCode: { type: DataTypes.STRING(20), allowNull: false },
    subCategoryName: { type: DataTypes.STRING(100), allowNull: false },
    subCategoryNameAr: { type: DataTypes.STRING(100), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhSubCategories',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['categoryId', 'subCategoryCode'] },
    ],
});
