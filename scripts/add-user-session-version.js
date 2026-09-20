// backend/scripts/add-user-session-version.js
// Adds InsUser.sessionVersion for single-active-session enforcement (see
// models/User.js). Checks INFORMATION_SCHEMA first since this DB server
// (MariaDB 5.5) doesn't support "ADD COLUMN IF NOT EXISTS" -- safe to
// re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelize2.query(`
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InsUser' AND COLUMN_NAME = 'sessionVersion'
        `);
        if (existing.length > 0) {
            console.log("↷ InsUser.sessionVersion already exists");
        } else {
            await sequelize2.query(`
                ALTER TABLE InsUser ADD COLUMN sessionVersion INT NOT NULL DEFAULT 0
            `);
            console.log("✅ Added InsUser.sessionVersion");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add sessionVersion column:", err);
        process.exit(1);
    }
};

run();
