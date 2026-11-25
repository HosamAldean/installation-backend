// backend/models/SoftwareLibrary.js
// IT software library (2026-11-25, phase 1): the approved apps the company
// uses -- current version, where the installer lives, how to install it
// silently, its SHA-256, and which IT license covers it. The installed-
// software inventory (services/softwareInventory.js, from the PC reports)
// is matched against matchPattern to show who has it and who is out of date.
// Phase 2 (installing from the app) will only ever run installers listed
// here whose file matches sha256.
//
// New table only (scripts/create-software-library-table.js). No secrets:
// licence keys stay out of here, like ItLicense.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const SOFTWARE_CATEGORIES = [
    'design', 'office', 'erp', 'utility', 'security', 'browser', 'driver', 'other',
];

export const SoftwareLibraryItem = sequelize2.define('SoftwareLibraryItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    vendor: { type: DataTypes.STRING(150), allowNull: true },
    category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other' },
    // The version PCs should have; older installed versions show as outdated.
    version: { type: DataTypes.STRING(60), allowNull: true },
    // Matches installed program names (case-insensitive text, or /regex/).
    matchPattern: { type: DataTypes.STRING(200), allowNull: false },
    installerPath: { type: DataTypes.STRING(500), allowNull: true },
    installArgs: { type: DataTypes.STRING(500), allowNull: true },
    sha256: { type: DataTypes.STRING(64), allowNull: true },
    licenseId: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' }, // active | retired
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'SoftwareLibraryItems',
    timestamps: true,
});
