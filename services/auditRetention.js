// backend/services/auditRetention.js
// Keeps the audit tables from growing forever. Once a day it deletes rows
// older than AUDIT_RETENTION_DAYS (default 730 = 2 years) from the
// high-volume logs, in small batches so a big first purge never locks a
// table for long. Low-volume change histories (UserAccountAudits,
// PermissionGrantAudits, AdminActionAudits) are kept forever -- they are
// tiny and are the record of who was given which access.
import { QueryTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;

// table -> extra WHERE (on top of the age check)
const TABLES = [
    ['ActivityAudits', ''],
    ['LoginAudits', ''],
    ['UnauthorizedAccessAudits', ''],
    ['SecurityAlerts', 'AND acknowledged = 1'],
];

export function retentionDays() {
    const n = parseInt(process.env.AUDIT_RETENTION_DAYS, 10);
    return Number.isFinite(n) && n >= 90 ? n : 730; // never below 90 days
}

export async function purgeOldAuditRows() {
    const days = retentionDays();
    const result = {};
    for (const [table, extra] of TABLES) {
        let total = 0;
        try {
            for (;;) {
                const [, meta] = await sequelize2.query(
                    `DELETE FROM IIT_Petra.${table}
                     WHERE createdAt < UTC_TIMESTAMP() - INTERVAL :days DAY ${extra}
                     LIMIT ${BATCH}`,
                    { replacements: { days }, type: QueryTypes.RAW }
                );
                const n = meta?.affectedRows ?? 0;
                total += n;
                if (n < BATCH) break;
            }
        } catch (err) {
            console.error(`❌ Audit retention failed for ${table}:`, err.message);
        }
        result[table] = total;
    }
    const removed = Object.values(result).reduce((a, b) => a + b, 0);
    if (removed) console.log(`🧹 Audit retention (${days} days):`, result);
    return result;
}

export function startAuditRetention() {
    // First run a few minutes after start, so it never competes with boot.
    setTimeout(() => purgeOldAuditRows().catch(() => {}), 5 * 60 * 1000).unref();
    setInterval(() => purgeOldAuditRows().catch(() => {}), DAY_MS).unref();
}
