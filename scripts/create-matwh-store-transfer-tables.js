// ------------------------------------------------------
// backend/scripts/create-matwh-store-transfer-tables.js
// ------------------------------------------------------
// Creates the 2 Store Transfer tables (header + lines). Uses each model's
// own .sync() (create-if-missing, non-destructive), same pattern as
// create-matwh-stock-count-tables.js. Safe to re-run.
import { MatWhStoreTransfer } from "../models/MatWhStoreTransfer.js";
import { MatWhStoreTransferLine } from "../models/MatWhStoreTransferLine.js";

const run = async () => {
    try {
        await MatWhStoreTransfer.sync();
        console.log("✅ matWhStoreTransfers ready");
        await MatWhStoreTransferLine.sync();
        console.log("✅ matWhStoreTransferLines ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create store transfer tables:", err);
        process.exit(1);
    }
};

run();
