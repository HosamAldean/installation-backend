// backend/models/SecurityAlert.js
// Persisted record of an automatically-detected suspicious login pattern --
// currently just 'credential_spray' (services/securityMonitor.js): one IP
// failing logins against several DIFFERENT usernames within a short window,
// the actual brute-force/credential-stuffing signature, as opposed to one
// account being repeatedly mistyped from its own device (which is normal
// noise, not an attack -- see routes/audit.js's /suspicious-activity for
// the raw aggregates this is built on top of).
//
// Deliberately its own table rather than folded into AdminActionAudit --
// these aren't admin-performed actions, they're system-detected events with
// their own lifecycle (an admin acknowledges one after reviewing it, same
// shape as a real security-tool alert queue).
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const SecurityAlert = sequelize2.define('SecurityAlert', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    type: { type: DataTypes.ENUM('credential_spray'), allowNull: false, defaultValue: 'credential_spray' },
    ip: { type: DataTypes.STRING, allowNull: false },
    distinctUsernames: { type: DataTypes.INTEGER, allowNull: false },
    failCount: { type: DataTypes.INTEGER, allowNull: false },
    windowMinutes: { type: DataTypes.INTEGER, allowNull: false },
    // JSON-encoded array of the usernames involved (capped -- see
    // securityMonitor.js), for a human reviewing the alert without having
    // to separately query /suspicious-activity/ip/:ip/usernames.
    usernames: { type: DataTypes.TEXT, allowNull: true },
    notifiedAdmins: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    acknowledged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    acknowledgedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    acknowledgedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'SecurityAlerts',
    timestamps: true,
    updatedAt: false,
});
