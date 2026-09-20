// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-costing-table.js
// ------------------------------------------------------
// Creates the WH.4 matWhItemCost table. Uses the model's own .sync()
// (create-if-missing, non-destructive), same pattern as the WH.1-WH.3
// create-tables scripts. Safe to re-run.
import { MatWhItemCost } from "../models/MatWhItemCost.js";

const run = async () => {
    try {
        await MatWhItemCost.sync();
        console.log("✅ matWhItemCost ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create matWhItemCost table:", err);
        process.exit(1);
    }
};

run();
