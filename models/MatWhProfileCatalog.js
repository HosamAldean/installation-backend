// backend/models/MatWhProfileCatalog.js
// IIT_Petra.matWhProfileCatalog -- profile-level catalog (photo, Arabic
// name, free-text details) for the Materials Warehouse's Profile Store
// sub-module, replacing Stock House's guest.ItemProfile. Kept separate from
// matWhItems per explicit direction: this item type is identified by
// profile+color+length (see MatWhProfileStock), not a single itemCode, so
// it doesn't fit the generic item master.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileCatalog = sequelizeUtf8.define('MatWhProfileCatalog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileNo: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    profileName: { type: DataTypes.STRING(255), allowNull: false },
    profileNameAr: { type: DataTypes.STRING(255), allowNull: true },
    // SKU-level barcode, same field/convention as matWhItems.barcode --
    // added so both item catalogs (general accessories + aluminum
    // profiles) carry the same barcode identity, matching the old system
    // and Alpha's InvItemsMF. Nullable: existing rows have none yet.
    barcode: { type: DataTypes.STRING(50), allowNull: true, unique: true },
    // Same picklist convention as matWhItems.category/subCategory (plain
    // string storing a matWhCategories/matWhSubCategories row's code, not
    // a real FK). Every profile here is aluminum, matching Alpha's own
    // 'ALM' category -- but subCategory (Alpha's SHUCO/PZ/NR/etc., tracked
    // per physical unit there, not per profile type) can't be determined
    // per-profile without an unreliable name-based guess, so it's left for
    // hand entry.
    category: { type: DataTypes.STRING(20), allowNull: true },
    subCategory: { type: DataTypes.STRING(20), allowNull: true },
    // Same picklist convention as matWhItems.baseUnit/altUnit -- plain
    // string storing a matWhUnits row's code. conversionFactor/minQty
    // mirror matWhItems' own fields (altUnit qty = baseUnit qty *
    // conversionFactor). All 4 are best-effort backfilled from Alpha's
    // InvItemsMF where a profile's name uniquely matches one Alpha item
    // (see backfill-matwh-profile-from-alpha-by-name.js) -- left NULL
    // otherwise, same as barcode.
    baseUnit: { type: DataTypes.STRING(20), allowNull: true },
    altUnit: { type: DataTypes.STRING(20), allowNull: true },
    conversionFactor: { type: DataTypes.FLOAT, allowNull: true },
    minQty: { type: DataTypes.FLOAT, allowNull: true },
    details: { type: DataTypes.TEXT, allowNull: true },
    detailsAr: { type: DataTypes.TEXT, allowNull: true },
    photoUrl: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhProfileCatalog',
    timestamps: true,
});
