// backend/models/SoftwareDeployJob.js
// Software Library phase 2 (2026-11-26): one row = "install this library
// item on this PC". The PC picks it up with its next report
// (Send-PcReport.ps1, as SYSTEM, at startup and every 4 h), copies the
// installer from \\PETRA-FILES\Software$, checks the SHA-256 against the
// value frozen here, runs it silently and reports the result.
//
// Path, hash and arguments are copied from the library item when the job is
// created, so editing the item later never changes a queued job.
// New table only (scripts/create-software-deploy-table.js).
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

// pending -> sent (handed to the PC) -> success | failed ; pending -> cancelled
export const DEPLOY_STATUSES = ['pending', 'sent', 'success', 'failed', 'cancelled'];

export const SoftwareDeployJob = sequelize2.define('SoftwareDeployJob', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    itemName: { type: DataTypes.STRING(200), allowNull: true },
    computerName: { type: DataTypes.STRING(63), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    installerPath: { type: DataTypes.STRING(500), allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    installArgs: { type: DataTypes.STRING(500), allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    exitCode: { type: DataTypes.INTEGER, allowNull: true },
    message: { type: DataTypes.STRING(1000), allowNull: true },
    requestedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    cancelledByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'SoftwareDeployJobs',
    timestamps: true,
    indexes: [{ fields: ['computerName', 'status'] }, { fields: ['itemId'] }],
});
