// ------------------------------------------------------
// backend/scripts/create-matwh-request-keys-table.js
// ------------------------------------------------------
// Creates matWhRequestKeys (see models/MatWhRequestKey.js). Uses the
// model's own .sync() (create-if-missing, non-destructive), same pattern as
// create-matwh-store-transfer-tables.js. Safe to re-run.
import { MatWhRequestKey } from "../models/MatWhRequestKey.js";

const run = async () => {
    try {
        await MatWhRequestKey.sync();
        console.log("✅ matWhRequestKeys ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create matWhRequestKeys:", err);
        process.exit(1);
    }
};

run();
