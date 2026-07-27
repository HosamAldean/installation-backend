// ------------------------------------------------------
// backend/scripts/add-user-push-token.js
// ------------------------------------------------------
// Adds pushToken to the existing InsUser table (MySQL, sequelize2 /
// IIT_Petra schema) for storing each account's Expo push token. See
// models/User.js for the field rationale. Safe to re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelize2.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InsUser' AND COLUMN_NAME = 'pushToken'
        `);

        if (existing.length > 0) {
            console.log("⏭️  pushToken already exists, skipping");
            process.exit(0);
        }

        await sequelize2.query("ALTER TABLE `InsUser` ADD COLUMN `pushToken` VARCHAR(255) NULL");
        console.log("✅ Added InsUser.pushToken");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add pushToken column:", err);
        process.exit(1);
    }
};

run();
