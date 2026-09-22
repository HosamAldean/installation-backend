// backend/scripts/create-ittihad-attendance-table.js
// Creates the IttihadClockImportRows staging table (MySQL, sequelizeUtf8)
// backing the HR-only Ittihad clock-import review page -- see
// routes/ittihadAttendance.js. Uses the model's own .sync()
// (create-if-missing, non-destructive), same convention as
// create-hr-tables.js. Safe to re-run.
import { IttihadClockImportRow } from "../models/index.js";

const run = async () => {
    try {
        await IttihadClockImportRow.sync();
        console.log("✅ IttihadClockImportRows ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create Ittihad attendance table:", err);
        process.exit(1);
    }
};

run();
