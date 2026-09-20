// ------------------------------------------------------
// backend/scripts/create-security-alerts-table.js
// ------------------------------------------------------
// Creates SecurityAlerts (models/SecurityAlert.js), backing the new
// credential-spray monitor (services/securityMonitor.js). Uses the model's
// own .sync() (create-if-missing, non-destructive), same as
// create-materials-warehouse-tables.js. Safe to re-run.
import { SecurityAlert } from "../models/SecurityAlert.js";

const run = async () => {
    try {
        await SecurityAlert.sync();
        console.log("✅ SecurityAlerts ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create SecurityAlerts table:", err);
        process.exit(1);
    }
};

run();
