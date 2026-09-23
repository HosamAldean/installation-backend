// backend/models/MatWhItemVariant.js
// IIT_Petra.matWhItemVariants -- one row per real, physically-barcoded SKU
// of a profile item: a specific color+length combination. Additive to
// matWhItems, not a replacement -- matWhItems stays one row per profile
// TYPE (name, category, unit); this table is the variant layer underneath
// it, mirroring how color already became a queryable matWhStockLedger
// dimension in Phase 3 rather than a catalog-row split (see that model's
// own comment). Only items that actually vary by color/length (category
// 'ALM') are expected to have rows here -- plain accessories keep using
// matWhItems.barcode directly, unchanged.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhItemVariant = sequelizeUtf8.define('MatWhItemVariant', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    // NULL means mill-finish/raw -- the same convention as everywhere else
    // in this module (matWhLedger.js's normalizeColor aliases 'MILL' to
    // null at every boundary; this table follows the same rule at its own
    // read/write boundary in routes/materialsWarehouse.js).
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    // The real, physically-scannable barcode for this exact variant --
    // globally unique (a scan has to resolve to exactly one variant).
    barcode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhItemVariants',
    timestamps: true,
});
