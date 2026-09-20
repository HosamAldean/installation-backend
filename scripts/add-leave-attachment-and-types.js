// ------------------------------------------------------
// backend/scripts/add-leave-attachment-and-types.js
// ------------------------------------------------------
// Extends HrLeaveRequests.leaveType's ENUM with 'sick' and 'work_injury',
// and adds attachmentUrl/attachmentMimeType columns for the
// mandatory-attachment types (sick, condolence_occasional). Same
// idempotent check-then-ALTER pattern as add-hr-export-tracking.js.
// MySQL has no "ADD ENUM VALUE" -- altering an ENUM requires MODIFY COLUMN
// with the full new value list, so the leaveType ALTER always runs the
// MODIFY unconditionally (safe to re-run: MySQL no-ops an unchanged
// column definition) rather than being skipped by an existence check the
// way a brand-new column would be.
import { sequelizeUtf8 } from "../config/db.js";

const run = async () => {
    try {
        await sequelizeUtf8.query(`
            ALTER TABLE \`HrLeaveRequests\`
            MODIFY COLUMN \`leaveType\` ENUM(
                'annual',
                'absence_by_request',
                'condolence_occasional',
                'maternity_paternity',
                'hajj',
                'study',
                'sick',
                'work_injury'
            ) NULL
        `);
        console.log("✅ HrLeaveRequests.leaveType ENUM now includes 'sick' and 'work_injury'");

        for (const column of ["attachmentUrl", "attachmentMimeType"]) {
            const [existing] = await sequelizeUtf8.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HrLeaveRequests' AND COLUMN_NAME = ?
            `, { replacements: [column] });
            if (existing.length > 0) {
                console.log(`⏭️  HrLeaveRequests.${column} already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`HrLeaveRequests\` ADD COLUMN \`${column}\` VARCHAR(255) NULL`);
            console.log(`✅ Added HrLeaveRequests.${column}`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add leave attachment columns/types:", err);
        process.exit(1);
    }
};

run();
