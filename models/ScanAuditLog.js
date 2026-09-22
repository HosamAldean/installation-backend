// backend/models/ScanAuditLog.js
// Server-side record of warehouse barcode scans, one row per scan. Exists
// so the "audit trail" a field worker sees is a verifiable record rather
// than a browser localStorage entry the same worker could clear or that
// disappears when they switch devices -- see the nav/UX review's §3
// finding on ScanAuditTrail.tsx. Deliberately append-only: no update/delete
// route exists for this table.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const ScanAuditLog = sequelizeUtf8.define('ScanAuditLog', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    barcode: { type: DataTypes.STRING, allowNull: false },
    status: {
        type: DataTypes.ENUM('OK', 'PROJECT_MISMATCH', 'NOT_FOUND'),
        allowNull: false,
    },
    projectNo: { type: DataTypes.STRING, allowNull: true },
    projectName: { type: DataTypes.STRING, allowNull: true },
    hireNote: { type: DataTypes.STRING, allowNull: true },
    scannedAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'ScanAuditLogs',
    timestamps: false,
});
