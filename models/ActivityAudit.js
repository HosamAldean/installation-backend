// backend/models/ActivityAudit.js
// One row per data-changing API request (POST/PUT/PATCH/DELETE) made by a
// signed-in user -- written by middleware/activityAudit.js for EVERY module,
// so "who changed what, when" no longer depends on each route file
// remembering to call its own audit helper (before 2026-11 only lookups,
// announcements, IT licenses, Stock House and warehouse store access did).
// The module-specific audit tables (AdminActionAudits, UserAccountAudits,
// PermissionGrantAudits) stay as they are: they hold field-level diffs this
// generic log can't know about. This one holds the request itself: route,
// ids, a redacted copy of the body, and the outcome.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const ActivityAudit = sequelize2.define('ActivityAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    username: { type: DataTypes.STRING(100), allowNull: true },
    role: { type: DataTypes.STRING(50), allowNull: true },
    method: { type: DataTypes.STRING(8), allowNull: false },
    // Express route pattern, e.g. /api/hr-requests/:id/decision -- groups
    // the same action together; `path` keeps the real ids.
    route: { type: DataTypes.STRING(255), allowNull: true },
    path: { type: DataTypes.STRING(500), allowNull: false },
    module: { type: DataTypes.STRING(64), allowNull: true },
    status: { type: DataTypes.INTEGER, allowNull: false },
    platform: { type: DataTypes.STRING(10), allowNull: true }, // 'web' | 'mobile'
    ip: { type: DataTypes.STRING(64), allowNull: true },
    params: { type: DataTypes.TEXT, allowNull: true }, // JSON (route params + query)
    body: { type: DataTypes.TEXT, allowNull: true }, // JSON, redacted + truncated
    durationMs: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'ActivityAudits',
    timestamps: true,
    updatedAt: false,
    indexes: [
        { fields: ['createdAt'] },
        { fields: ['userId', 'createdAt'] },
        { fields: ['module', 'createdAt'] },
    ],
});
