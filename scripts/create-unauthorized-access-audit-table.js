// ------------------------------------------------------
// backend/scripts/create-unauthorized-access-audit-table.js
// ------------------------------------------------------
// Creates the UnauthorizedAccessAudits table (MySQL, sequelize2). See
// models/UnauthorizedAccessAudit.js for the field rationale. Uses the
// model's own .sync() (create-if-missing, non-destructive). Safe to
// re-run.
import { UnauthorizedAccessAudit } from "../models/UnauthorizedAccessAudit.js";

const run = async () => {
    try {
        await UnauthorizedAccessAudit.sync();
        console.log("✅ UnauthorizedAccessAudits ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create UnauthorizedAccessAudits table:", err);
        process.exit(1);
    }
};

run();
