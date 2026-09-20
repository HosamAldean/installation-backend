// backend/models/Announcement.js
// Admin-broadcast in-app banner -- shown to every logged-in user (or just
// one role, if targetRole is set) via the global banner mounted in
// ProtectedRoute. `active` is a soft retract (toggle off instead of
// deleting, so history survives for the Admin Action Log); expiresAt is
// optional auto-expiry so a time-boxed notice (e.g. "maintenance window
// tonight") doesn't need a manual follow-up to take down.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const Announcement = sequelize2.define('Announcement', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    message: { type: DataTypes.TEXT, allowNull: false },
    severity: { type: DataTypes.ENUM('info', 'warning', 'critical'), allowNull: false, defaultValue: 'info' },
    // null = every role (all users); otherwise only that role sees it.
    targetRole: { type: DataTypes.STRING, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'Announcements',
    timestamps: true,
    updatedAt: true,
});
