// ------------------------------------------------------
// backend/scripts/add-overtime-hours-column.js
// ------------------------------------------------------
// Adds the `hours` column to the existing HrOvertimeRequests table (MySQL,
// sequelizeUtf8) -- the paper form's per-employee "عدد الساعات" column,
// now a single field on the request itself since the employee table was
// dropped (self-service, one request per employee, see models/
// HrOvertimeRequest.js). The old `department` column is left in place,
// unused -- harmless, and avoids a destructive DROP COLUMN.
//
// HrOvertimeRequests already exists (created via create-hr-tables.js's
// model .sync(), which only creates missing tables -- it doesn't alter
// existing ones), so this checks INFORMATION_SCHEMA.COLUMNS first and only
// ALTERs if missing. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelizeUtf8.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HrOvertimeRequests' AND COLUMN_NAME = 'hours'
        `);
        if (existing.length > 0) {
            console.log("⏭️  hours already exists, skipping");
        } else {
            await sequelizeUtf8.query(`ALTER TABLE \`HrOvertimeRequests\` ADD COLUMN \`hours\` FLOAT NULL`);
            console.log("✅ Added hours");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add overtime hours column:", err);
        process.exit(1);
    }
};

run();
