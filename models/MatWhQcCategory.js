// backend/models/MatWhQcCategory.js
// IIT_Petra.matWhQcCategories -- QC defect/finding categories for goods
// receipt. Stock House's fixed accept/loss/reject split (see EnterDou,
// routes/stockHouse.js) doesn't fit every material -- paint fails
// differently than aluminum profile. appliesToVendorId scopes a category
// set to one vendor (e.g. Mix Paints); null means generic, applicable to
// any receipt. Seeded, not hardcoded, so QC categories can be added later
// without a deploy. See the Alpha Warehouse Analysis report §10.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhQcCategory = sequelizeUtf8.define('MatWhQcCategory', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    categoryCode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    categoryName: { type: DataTypes.STRING(100), allowNull: false },
    categoryNameAr: { type: DataTypes.STRING(100), allowNull: true },
    appliesToVendorId: { type: DataTypes.INTEGER, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhQcCategories',
    timestamps: false,
});
