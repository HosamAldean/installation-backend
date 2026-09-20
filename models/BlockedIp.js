// backend/models/BlockedIp.js
// Admin-managed IP blocklist -- unlike PayslipVisibility's single switch,
// this is a real list (any number of IPs), each independently
// added/removed. Checked on every request via middleware/ipBlock.js's
// cached Set, not a query per request.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const BlockedIp = sequelize2.define('BlockedIp', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    // Capped at 64 (IPv6 max is 45 chars) rather than STRING's default 255
    // -- a unique index on a utf8mb4 VARCHAR(255) exceeds MySQL's 767-byte
    // max key length on this server's row format, confirmed live.
    ip: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    reason: { type: DataTypes.STRING, allowNull: true },
    blockedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'BlockedIps',
    timestamps: true,
    updatedAt: false,
});
