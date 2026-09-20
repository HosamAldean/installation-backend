// ------------------------------------------------------
// backend/scripts/create-team-vacations-table.js
// ------------------------------------------------------
// Creates the InstTeamVacations table backing the Schedule page's daily
// team roster "on vacation" status (see backend/models/InstTeamVacation.js).
// Lives on the sequelizeUtf8 MySQL connection, same as
// create-scan-audit-log-table.js -- a genuinely new table with no legacy
// Access/ERP equivalent.
//
// Uses the model's own .sync() (create-if-missing, non-destructive). Safe
// to re-run.
import { InstTeamVacation } from "../models/InstTeamVacation.js";

const run = async () => {
    try {
        await InstTeamVacation.sync();
        console.log("✅ InstTeamVacations ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create InstTeamVacations table:", err);
        process.exit(1);
    }
};

run();
