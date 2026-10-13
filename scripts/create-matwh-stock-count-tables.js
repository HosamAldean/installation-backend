// ------------------------------------------------------
// backend/scripts/create-matwh-stock-count-tables.js
// ------------------------------------------------------
// Creates the 2 Stock Count tables (header + lines). Uses each model's own
// .sync() (create-if-missing, non-destructive), same pattern as
// create-materials-warehouse-writeoff-tables.js. Safe to re-run.
import { MatWhStockCount } from "../models/MatWhStockCount.js";
import { MatWhStockCountLine } from "../models/MatWhStockCountLine.js";

const run = async () => {
    try {
        await MatWhStockCount.sync();
        console.log("✅ matWhStockCounts ready");
        await MatWhStockCountLine.sync();
        console.log("✅ matWhStockCountLines ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create stock count tables:", err);
        process.exit(1);
    }
};

run();
