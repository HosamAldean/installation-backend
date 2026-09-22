// ------------------------------------------------------
// backend/scripts/add-announcement-to-admin-action-enum.js
// ------------------------------------------------------
// AdminActionAudits.module is a MySQL ENUM -- model.sync() (create-if-
// missing) doesn't ALTER an existing column's ENUM values, so 'announcement'
// (added for the Announcements admin tool) needs an explicit ALTER. Safe to
// re-run; table has no real data yet at the time this was written.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        await sequelize2.query(
            "ALTER TABLE AdminActionAudits MODIFY module ENUM('lookup','profile_assembly','item_profile','announcement') NOT NULL"
        );
        console.log("✅ AdminActionAudits.module ENUM updated");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to alter AdminActionAudits.module:", err);
        process.exit(1);
    }
};

run();
