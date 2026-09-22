// ------------------------------------------------------
// backend/scripts/create-project-map-cache-table.js
// ------------------------------------------------------
// Creates the ProjectMapCache table backing resolved short Google-Maps-link
// coordinates for the Schedule page's team roster (see
// backend/models/ProjectMapCache.js). Lives on the sequelizeUtf8 MySQL
// connection, same as create-team-vacations-table.js -- a genuinely new
// table with no legacy Access/ERP equivalent.
//
// Uses the model's own .sync() (create-if-missing, non-destructive). Safe
// to re-run.
import { ProjectMapCache } from "../models/ProjectMapCache.js";

const run = async () => {
    try {
        await ProjectMapCache.sync();
        console.log("✅ ProjectMapCache ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create ProjectMapCache table:", err);
        process.exit(1);
    }
};

run();
