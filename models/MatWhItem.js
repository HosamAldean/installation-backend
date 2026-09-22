// backend/models/MatWhItem.js
// IIT_Petra.matWhItems -- material/item master for the new Materials
// Warehouse module (WH.1). Reorder fields and multi-unit conversion are
// carried from day one per the Alpha Warehouse Analysis report §10 --
// modeled after Alpha's InvItemsMF, cheap to add now, expensive to retrofit
// later.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhItem = sequelizeUtf8.define('MatWhItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemCode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    itemName: { type: DataTypes.STRING(255), allowNull: false },
    itemNameAr: { type: DataTypes.STRING(255), allowNull: true },
    // SKU-level barcode (Code128, per the Material Store plan's §07) --
    // nullable since not every item has one yet (imported from the old
    // system/Alpha where available, entered by hand otherwise), unique so
    // a scan resolves to exactly one item.
    barcode: { type: DataTypes.STRING(50), allowNull: true, unique: true },
    // Free-text profile details, same shape as matWhProfileCatalog's own
    // details/detailsAr -- requested so the general item catalog gets the
    // same "profile" treatment as the aluminum Profile Store, not just a
    // bare code+name row.
    details: { type: DataTypes.TEXT, allowNull: true },
    detailsAr: { type: DataTypes.TEXT, allowNull: true },
    // Filename only (not a full URL), same convention as
    // matWhProfileCatalog.photoUrl -- served from uploads/item-photos/.
    photoUrl: { type: DataTypes.STRING(255), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    subCategory: { type: DataTypes.STRING(100), allowNull: true },
    baseUnit: { type: DataTypes.STRING(20), allowNull: false },
    altUnit: { type: DataTypes.STRING(20), allowNull: true },
    // altUnit quantity = baseUnit quantity * conversionFactor.
    conversionFactor: { type: DataTypes.FLOAT, allowNull: true },
    minQty: { type: DataTypes.FLOAT, allowNull: true },
    maxQty: { type: DataTypes.FLOAT, allowNull: true },
    reorderQty: { type: DataTypes.FLOAT, allowNull: true },
    preferredVendorId: { type: DataTypes.INTEGER, allowNull: true },
    allowPurchase: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    allowIssue: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhItems',
    timestamps: false,
});
