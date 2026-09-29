// backend/models/MatWhUserVendorAssignment.js
// IIT_Petra.matWhUserVendorAssignments -- which users may act on which
// vendor(s) in the coating-vendor portal (routes/
// materialsWarehouseCoatingVendor.js). Same join-table shape as
// MatWhUserStoreAssignment (one user could cover more than one vendor
// later), but unlike that one, THIS table is the actual real-time
// enforcement mechanism for its portal -- every request there is scoped by
// `processVendorId IN (this user's assigned vendorIds)`, not just an
// unenforced admin-editable list.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhUserVendorAssignment = sequelizeUtf8.define('MatWhUserVendorAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    vendorId: { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'matWhUserVendorAssignments',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['userId', 'vendorId'] },
    ],
});
