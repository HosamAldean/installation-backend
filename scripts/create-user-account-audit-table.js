// ------------------------------------------------------
// backend/scripts/create-user-account-audit-table.js
// ------------------------------------------------------
// Creates the UserAccountAudits table (MySQL, sequelize2). See models/
// UserAccountAudit.js for the field rationale. Uses the model's own
// .sync() (create-if-missing, non-destructive). Safe to re-run.
import { UserAccountAudit } from "../models/UserAccountAudit.js";

const run = async () => {
    try {
        await UserAccountAudit.sync();
        console.log("✅ UserAccountAudits ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create UserAccountAudits table:", err);
        process.exit(1);
    }
};

run();
