// ------------------------------------------------------
// backend/scripts/create-blocked-ips-table.js
// ------------------------------------------------------
// Creates the BlockedIps table (MySQL, sequelize2). See models/
// BlockedIp.js for the field rationale. Uses the model's own .sync()
// (create-if-missing, non-destructive). Safe to re-run.
import { BlockedIp } from "../models/BlockedIp.js";

const run = async () => {
    try {
        await BlockedIp.sync();
        console.log("✅ BlockedIps ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create BlockedIps table:", err);
        process.exit(1);
    }
};

run();
