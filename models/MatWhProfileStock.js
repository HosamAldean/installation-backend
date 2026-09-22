// backend/models/MatWhProfileStock.js
// IIT_Petra.matWhProfileStock -- the real trackable stock-keeping unit for
// the Profile Store sub-module: one row per profile+color+length+store
// combination, replacing Stock House's implicit guest.EnterDouC registry
// (which only ever existed as a derived lookup, never an explicit table).
// Making it explicit here is what lets `barcode` and the new
// locationColumn/locationRow fields exist as real columns instead of being
// looked up from transaction history.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileStock = sequelizeUtf8.define('MatWhProfileStock', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileCatalogId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    color: { type: DataTypes.STRING(50), allowNull: false },
    lengthMm: { type: DataTypes.FLOAT, allowNull: false },
    // The barcode-equivalent unique reference for this exact
    // profile+color+length+store combination -- scanned/entered at every
    // data-entry point (receive, reserve, ship, return, coating, transfer),
    // same role Stock House's ComputerNO played.
    barcode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    zone: { type: DataTypes.STRING(20), allowNull: true },
    locationColumn: { type: DataTypes.STRING(20), allowNull: true },
    locationRow: { type: DataTypes.STRING(20), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhProfileStock',
    timestamps: true,
    indexes: [
        { unique: true, fields: ['profileCatalogId', 'color', 'lengthMm', 'storeId'] },
    ],
});
