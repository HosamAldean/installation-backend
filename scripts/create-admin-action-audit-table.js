// ------------------------------------------------------
// backend/scripts/create-admin-action-audit-table.js
// ------------------------------------------------------
// Creates the AdminActionAudits table (MySQL, sequelize2). See models/
// AdminActionAudit.js for the field rationale. Uses the model's own
// .sync() (create-if-missing, non-destructive). Safe to re-run.
import { AdminActionAudit } from "../models/AdminActionAudit.js";

const run = async () => {
    try {
        await AdminActionAudit.sync();
        console.log("✅ AdminActionAudits ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create AdminActionAudits table:", err);
        process.exit(1);
    }
};

run();
