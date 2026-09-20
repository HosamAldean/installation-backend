// backend/scripts/add-user-mobile-app-version.js
// Adds InsUser.lastMobileAppVersionCode/lastMobileAppVersionCheckedAt --
// recorded on every mobile login attempt (see routes/auth.js) so a stale
// build can be force-blocked at login time (see
// constants/mobileAppVersion.js's MIN_SUPPORTED_VERSION_CODE) and so IT
// can find which devices are still on an old build to re-notify them
// directly. Checks INFORMATION_SCHEMA first since this DB server (MariaDB
// 5.5) doesn't support "ADD COLUMN IF NOT EXISTS" -- safe to re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelize2.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InsUser'
              AND COLUMN_NAME IN ('lastMobileAppVersionCode', 'lastMobileAppVersionCheckedAt')
        `);
        const existingNames = new Set(existing.map((r) => r.COLUMN_NAME));

        if (!existingNames.has('lastMobileAppVersionCode')) {
            await sequelize2.query(`ALTER TABLE InsUser ADD COLUMN lastMobileAppVersionCode INT NULL`);
            console.log("✅ Added InsUser.lastMobileAppVersionCode");
        } else {
            console.log("↷ InsUser.lastMobileAppVersionCode already exists");
        }

        if (!existingNames.has('lastMobileAppVersionCheckedAt')) {
            await sequelize2.query(`ALTER TABLE InsUser ADD COLUMN lastMobileAppVersionCheckedAt DATETIME NULL`);
            console.log("✅ Added InsUser.lastMobileAppVersionCheckedAt");
        } else {
            console.log("↷ InsUser.lastMobileAppVersionCheckedAt already exists");
        }

        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add mobile app version columns:", err);
        process.exit(1);
    }
};

run();
