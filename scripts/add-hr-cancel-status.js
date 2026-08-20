// ------------------------------------------------------
// backend/scripts/add-hr-cancel-status.js
// ------------------------------------------------------
// Switches self-service "cancel" from a hard DELETE to a soft status
// change on all 3 HR request tables (MySQL, sequelizeUtf8) -- a canceled
// request stays on record instead of disappearing, so HR/managers can see
// it was withdrawn rather than never existed. Adds 'canceled' to the
// status ENUM and a canceledAt timestamp. Same idempotent
// check-then-ALTER pattern as add-hr-export-tracking.js.
import { sequelizeUtf8 } from "../config/db.js";

const TABLES = {
    HrLeaveRequests: "ENUM('pending_manager','pending_hr','approved','rejected','canceled')",
    HrAttendanceCorrectionRequests: "ENUM('pending_manager','pending_hr','approved','rejected','canceled')",
    HrTransportRequests: "ENUM('pending_manager','pending_hr_audit','pending_finance','approved','rejected','canceled')",
};

const run = async () => {
    try {
        for (const [table, enumDef] of Object.entries(TABLES)) {
            const [[col]] = await sequelizeUtf8.query(`
                SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'status'
            `, { replacements: [table] });
            if (col && col.COLUMN_TYPE.includes("'canceled'")) {
                console.log(`⏭️  ${table}.status already includes 'canceled', skipping`);
            } else {
                await sequelizeUtf8.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`status\` ${enumDef} NOT NULL DEFAULT 'pending_manager'`);
                console.log(`✅ Added 'canceled' to ${table}.status`);
            }

            const [existing] = await sequelizeUtf8.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'canceledAt'
            `, { replacements: [table] });
            if (existing.length > 0) {
                console.log(`⏭️  ${table}.canceledAt already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN \`canceledAt\` DATETIME NULL`);
            console.log(`✅ Added ${table}.canceledAt`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add HR cancel-status columns:", err);
        process.exit(1);
    }
};

run();
