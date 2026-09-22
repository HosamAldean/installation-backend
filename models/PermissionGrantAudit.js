// backend/models/PermissionGrantAudit.js
// Append-only history of every permission grant/revoke event -- backs the
// admin-only Audit Log's Permission Changes section. PermissionGrant
// itself (models/PermissionGrant.js) already has grantedByUserId + a
// createdAt timestamp, but that only describes the CURRENTLY-granted
// state: revoking a permission hard-deletes its row (routes/
// permissions.js's PUT / does PermissionGrant.destroy()), so there was no
// way to see that a permission ever existed, who granted it, or who
// revoked it and when. This table is written alongside that same route,
// never deleted, so it stays a true history regardless of what
// PermissionGrant's current live state looks like.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const PermissionGrantAudit = sequelize2.define('PermissionGrantAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    role: { type: DataTypes.STRING(64), allowNull: false },
    permissionKey: { type: DataTypes.STRING(64), allowNull: false },
    action: { type: DataTypes.ENUM('granted', 'revoked'), allowNull: false },
    performedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'PermissionGrantAudits',
    timestamps: true,
    updatedAt: false,
});
