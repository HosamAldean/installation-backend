// ------------------------------------------------------
// backend/scripts/create-inst-order-schedule-days-table.js
// ------------------------------------------------------
// Creates the InstOrderScheduleDays table backing the Schedule page's
// day-by-day team roster history (see
// backend/models/InstOrderScheduleDay.js). Lives on the sequelizeUtf8
// MySQL connection, same as create-team-vacations-table.js -- a genuinely
// new table with no legacy Access/ERP equivalent.
//
// Uses the model's own .sync() (create-if-missing, non-destructive). Safe
// to re-run.
import { InstOrderScheduleDay } from "../models/InstOrderScheduleDay.js";

const run = async () => {
    try {
        await InstOrderScheduleDay.sync();
        console.log("✅ InstOrderScheduleDays ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create InstOrderScheduleDays table:", err);
        process.exit(1);
    }
};

run();
