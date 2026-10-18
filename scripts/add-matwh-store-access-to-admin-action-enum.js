// ------------------------------------------------------
// backend/scripts/add-matwh-store-access-to-admin-action-enum.js
// ------------------------------------------------------
// Adds 'matwh_store_access' to AdminActionAudits.module (a MySQL ENUM --
// model.sync() never ALTERs an existing ENUM, same as
// add-ip-block-to-admin-action-enum.js) so Materials Warehouse store-access
// changes can be audited. Safe to re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        await sequelize2.query(
            "ALTER TABLE AdminActionAudits MODIFY module ENUM('lookup','profile_assembly','item_profile','announcement','rate_limit','ip_block','matwh_store_access') NOT NULL"
        );
        console.log("✅ AdminActionAudits.module ENUM updated");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to alter AdminActionAudits.module:", err);
        process.exit(1);
    }
};

run();
