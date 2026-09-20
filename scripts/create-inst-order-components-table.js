// ------------------------------------------------------
// backend/scripts/create-inst-order-components-table.js
// ------------------------------------------------------
// Creates the InstOrderComponents table backing the new component-based
// order-tracking page (see backend/models/InstOrderComponent.js). Lives on
// the sequelizeUtf8 connection, same as ScanAuditLogs/FollowUpNotes -- a
// genuinely new table with no legacy Access/ERP equivalent.
//
// Uses the model's own .sync() (create-if-missing, non-destructive), same
// as create-scan-audit-log-table.js. Safe to re-run.
import { InstOrderComponent } from "../models/InstOrderComponent.js";

const run = async () => {
    try {
        await InstOrderComponent.sync();
        console.log("✅ InstOrderComponents ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create InstOrderComponents table:", err);
        process.exit(1);
    }
};

run();
