// backend/models/Vendor.js
// IIT_Petra.vendors -- previously an orphaned legacy stub (vendorId/
// vendorName/vendorDesc, 10 rows, no application code touching it --
// confirmed via a full grep before adding this model). Extended here per
// the Alpha Warehouse Analysis report §10: rather than adding a third
// vendor table alongside Alpha's Vendors and this one (see Alpha's own
// dead Proc_*/Pur_* duplication for why that's a mistake worth avoiding),
// this table becomes the real vendor master for the new Materials
// Warehouse module. Mix Paints is one row here, nothing more (§08).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const Vendor = sequelizeUtf8.define('Vendor', {
    vendorId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    vendorName: { type: DataTypes.STRING(255), allowNull: true },
    vendorDesc: { type: DataTypes.STRING(255), allowNull: true },
    // Added by scripts/add-materials-warehouse-vendor-columns.js -- the
    // base three columns above already existed on the live table.
    paymentTerms: { type: DataTypes.STRING(100), allowNull: true },
    delayDays: { type: DataTypes.INTEGER, allowNull: true },
    currency: { type: DataTypes.STRING(10), allowNull: true },
    country: { type: DataTypes.STRING(100), allowNull: true },
    creditLimit: { type: DataTypes.FLOAT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'vendors',
    timestamps: false,
});
