// backend/models/AdminActionAudit.js
// Append-only history of edits to admin-only reference/catalog data --
// Lookups (routes/lookups.js), Profile Assemblies and Item Profiles
// (routes/stockHouse.js's guest.ProfileNOA / guest.ItemProfile). These are
// company-wide shared tables with no per-row owner and no other change
// history (Lookups is plain MySQL CRUD with no SUser/SDate columns at
// all; ProfileNOA/ItemProfile only keep the LAST editor via SUser/SDate,
// overwritten on every edit) -- this table is what lets an admin answer
// "who changed this row, and when" going back further than the latest
// edit. module distinguishes the three surfaces; entityType is only
// meaningful for module='lookup' (the lookup type key, e.g. 'orderStatus').
// entityLabel is denormalized (kept even after the row itself is deleted),
// same reasoning as LoginAudit.username/UserAccountAudit.targetUsername.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const AdminActionAudit = sequelize2.define('AdminActionAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    module: { type: DataTypes.ENUM('lookup', 'profile_assembly', 'item_profile', 'announcement', 'rate_limit', 'ip_block'), allowNull: false },
    entityType: { type: DataTypes.STRING, allowNull: true },
    entityId: { type: DataTypes.STRING, allowNull: false },
    entityLabel: { type: DataTypes.STRING, allowNull: true },
    action: { type: DataTypes.ENUM('created', 'updated', 'deleted'), allowNull: false },
    changes: { type: DataTypes.TEXT, allowNull: true },
    performedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'AdminActionAudits',
    timestamps: true,
    updatedAt: false,
});
