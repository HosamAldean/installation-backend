// backend/scripts/add-ittihad-posted-tracking.js
// Adds postedAsNewRow/postedShiftFields to IttihadClockImportRows --
// bookkeeping needed by the "delete posted" (undo) feature in
// routes/ittihadAttendance.js to know whether undoing a post should DELETE
// the TA_EmpTimeSheet row outright or only null back the fields we wrote.
// Table already exists (create-ittihad-attendance-table.js), so this is a
// plain ALTER rather than a fresh .sync(). The DB server is MariaDB 5.5,
// which doesn't support "ADD COLUMN IF NOT EXISTS" -- this checks
// INFORMATION_SCHEMA itself instead, which makes it safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const COLUMNS = [
    { name: "postedAsNewRow", ddl: "TINYINT(1) NULL" },
    { name: "postedShiftFields", ddl: "TINYINT(1) NULL" },
];

const run = async () => {
    try {
        for (const { name, ddl } of COLUMNS) {
            const [existing] = await sequelizeUtf8.query(`
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'IttihadClockImportRows' AND COLUMN_NAME = '${name}'
            `);
            if (existing.length > 0) {
                console.log(`↷ ${name} already exists`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE IttihadClockImportRows ADD COLUMN ${name} ${ddl}`);
            console.log(`✅ Added ${name}`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add posted-tracking columns:", err);
        process.exit(1);
    }
};

run();
