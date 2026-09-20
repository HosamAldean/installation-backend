// ------------------------------------------------------
// backend/scripts/add-ip-block-to-admin-action-enum.js
// ------------------------------------------------------
// AdminActionAudits.module is a MySQL ENUM -- model.sync() (create-if-
// missing) doesn't ALTER an existing column's ENUM values, so 'ip_block'
// (added for the admin IP blocklist) needs an explicit ALTER. Safe to
// re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        await sequelize2.query(
            "ALTER TABLE AdminActionAudits MODIFY module ENUM('lookup','profile_assembly','item_profile','announcement','rate_limit','ip_block') NOT NULL"
        );
        console.log("✅ AdminActionAudits.module ENUM updated");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to alter AdminActionAudits.module:", err);
        process.exit(1);
    }
};

run();
