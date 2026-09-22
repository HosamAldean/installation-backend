// ------------------------------------------------------
// backend/scripts/create-permission-grant-audit-table.js
// ------------------------------------------------------
// Creates the PermissionGrantAudits table (MySQL, sequelize2). See
// models/PermissionGrantAudit.js for the field rationale. Uses the
// model's own .sync() (create-if-missing, non-destructive). Safe to
// re-run.
import { PermissionGrantAudit } from "../models/PermissionGrantAudit.js";

const run = async () => {
    try {
        await PermissionGrantAudit.sync();
        console.log("✅ PermissionGrantAudits ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create PermissionGrantAudits table:", err);
        process.exit(1);
    }
};

run();
