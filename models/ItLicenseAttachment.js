// backend/models/ItLicenseAttachment.js
// Invoice / receipt files (PDF or image) for an ItLicense -- the purchase
// itself (renewalId null) or one of its renewals. Stored under
// private-uploads/it-licenses, NOT the public /uploads static folder, and
// only served through the admin-only route in routes/itLicenses.js.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const ItLicenseAttachment = sequelize2.define('ItLicenseAttachment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    licenseId: { type: DataTypes.INTEGER, allowNull: false },
    renewalId: { type: DataTypes.INTEGER, allowNull: true },
    fileName: { type: DataTypes.STRING(255), allowNull: false },
    storedName: { type: DataTypes.STRING(100), allowNull: false },
    mimeType: { type: DataTypes.STRING(100), allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    uploadedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'ItLicenseAttachments',
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ['licenseId'] }],
});
