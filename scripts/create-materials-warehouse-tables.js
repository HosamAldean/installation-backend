// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-tables.js
// ------------------------------------------------------
// Creates the 4 new master-data tables for WH.1 (Materials Warehouse):
// matWhStores, matWhItems, matWhUserStoreAssignments, matWhQcCategories.
// Uses each model's own .sync() (create-if-missing, non-destructive), same
// as create-hr-tables.js / create-scan-audit-log-table.js. Safe to re-run.
//
// matWhQcResults (the categorized QC-finding detail table) is deliberately
// NOT created here -- it FKs to goodsReceiptItemId, a WH.2 table that
// doesn't exist yet. It belongs in WH.2's own create-tables script.
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhUserStoreAssignment } from "../models/MatWhUserStoreAssignment.js";
import { MatWhQcCategory } from "../models/MatWhQcCategory.js";

const run = async () => {
    try {
        await MatWhStore.sync();
        console.log("✅ matWhStores ready");
        await MatWhItem.sync();
        console.log("✅ matWhItems ready");
        await MatWhUserStoreAssignment.sync();
        console.log("✅ matWhUserStoreAssignments ready");
        await MatWhQcCategory.sync();
        console.log("✅ matWhQcCategories ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create materials warehouse tables:", err);
        process.exit(1);
    }
};

run();
