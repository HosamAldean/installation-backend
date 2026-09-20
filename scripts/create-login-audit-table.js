// ------------------------------------------------------
// backend/scripts/create-login-audit-table.js
// ------------------------------------------------------
// Creates the LoginAudits table (MySQL, sequelize2 -- same connection as
// User/InsUser) backing the admin-only Audit Log screen. See models/
// LoginAudit.js for the field rationale. Uses the model's own .sync()
// (create-if-missing, non-destructive). Safe to re-run.
import { LoginAudit } from "../models/LoginAudit.js";

const run = async () => {
    try {
        await LoginAudit.sync();
        console.log("✅ LoginAudits ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create LoginAudits table:", err);
        process.exit(1);
    }
};

run();
