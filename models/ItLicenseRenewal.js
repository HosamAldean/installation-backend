// backend/models/ItLicenseRenewal.js
// One row per renewal of an ItLicense -- the expiry date moves forward on
// the license itself, this keeps the history (old/new expiry, cost).
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const ItLicenseRenewal = sequelize2.define('ItLicenseRenewal', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    licenseId: { type: DataTypes.INTEGER, allowNull: false },
    renewedOn: { type: DataTypes.DATEONLY, allowNull: false },
    previousExpiryDate: { type: DataTypes.DATEONLY, allowNull: true },
    newExpiryDate: { type: DataTypes.DATEONLY, allowNull: false },
    cost: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    renewedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'ItLicenseRenewals',
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ['licenseId'] }],
});
