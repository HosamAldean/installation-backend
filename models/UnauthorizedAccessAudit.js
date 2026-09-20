// backend/models/UnauthorizedAccessAudit.js
// Append-only log of 403s -- a logged-in user hitting a page/action their
// role/permission grants don't cover. Separate from the flat
// middleware/monitorLog.js file (which already records every >=400
// response) because that log isn't queryable/filterable and mixes in
// every other error class -- this table exists specifically so the admin
// Audit Log can surface "who's been probing for access" or "which role is
// missing a grant it clearly needs" without grepping a text file.
// Written from the three real authorization chokepoints (authorizeRoles/
// authorizeReadWrite in middleware/auth.js, requirePermission/
// blockWritesForReadOnlyRoles/blockGmWrites in middleware/permissions.js)
// rather than per-route, since those cover the overwhelming majority of
// this app's access boundaries. requiredAccess is free text describing
// what the check needed (e.g. "permission: LOOKUPS_EDIT", "role: admin")
// -- kept as one flexible field rather than separate permission/role
// columns since call sites describe the failure differently.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const UnauthorizedAccessAudit = sequelize2.define('UnauthorizedAccessAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    role: { type: DataTypes.STRING, allowNull: true },
    method: { type: DataTypes.STRING, allowNull: false },
    path: { type: DataTypes.STRING, allowNull: false },
    requiredAccess: { type: DataTypes.STRING, allowNull: true },
    ip: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'UnauthorizedAccessAudits',
    timestamps: true,
    updatedAt: false,
});
