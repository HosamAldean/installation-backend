// ------------------------------------------------------
// backend/scripts/add-hr-export-tracking.js
// ------------------------------------------------------
// Adds an exportedAt column to all 3 HR request tables (MySQL,
// sequelizeUtf8) -- lets the reports mark records as "already exported"
// (CSV or PDF) so a fresh export naturally only picks up new records
// instead of re-exporting everything every time. Same idempotent
// check-then-ALTER pattern as add-transport-payment-columns.js.
import { sequelizeUtf8 } from "../config/db.js";

const TABLES = [
    "HrLeaveRequests",
    "HrAttendanceCorrectionRequests",
    "HrTransportRequests",
];

const run = async () => {
    try {
        for (const table of TABLES) {
            const [existing] = await sequelizeUtf8.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'exportedAt'
            `, { replacements: [table] });
            if (existing.length > 0) {
                console.log(`⏭️  ${table}.exportedAt already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN \`exportedAt\` DATETIME NULL`);
            console.log(`✅ Added ${table}.exportedAt`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add HR export-tracking columns:", err);
        process.exit(1);
    }
};

run();
