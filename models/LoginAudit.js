// backend/models/LoginAudit.js
// Persisted record of every /auth/login attempt (success and failure) --
// backs the admin-only Audit Log screen. Previously there was no durable
// login history at all: successful logins only overwrote User.lastSeenAt
// (a single current-state snapshot, not a history), and failed logins only
// ever reached the flat, temporary backend/logs/monitor.log file (and even
// that only via its generic "any 4xx/5xx" catch-all -- /api/auth was never
// one of its watched prefixes).
//
// userId is nullable -- a login attempt against a username that doesn't
// exist at all (the common brute-force shape) has no real user to link to,
// but the attempt itself (and which username was tried, and from where) is
// exactly the signal worth keeping. username is stored as typed separately
// from the User relation for the same reason: it must survive even when
// userId is null.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const LoginAudit = sequelize2.define('LoginAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    username: { type: DataTypes.STRING, allowNull: false },
    ip: { type: DataTypes.STRING, allowNull: true },
    // 'mobile' iff the login request included appVersionCode (only the
    // mobile app ever sends it -- see routes/auth.js's /login).
    platform: { type: DataTypes.ENUM('web', 'mobile'), allowNull: false, defaultValue: 'web' },
    success: { type: DataTypes.BOOLEAN, allowNull: false },
    failureReason: {
        type: DataTypes.ENUM(
            'invalid_credentials',
            'inactive',
            'rate_limited',
            'update_required',
        ),
        allowNull: true,
    },
    appVersionCode: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'LoginAudits',
    timestamps: true,
    updatedAt: false,
});
