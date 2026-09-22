// ------------------------------------------------------
// backend/scripts/widen-delivery-note.js
// ------------------------------------------------------
// InsDelivered.InsDeliveredNote was VARCHAR(45) -- too short for a real
// delivery/missing-item note (MISSING status requires one, see
// routes/followUp.js's /delivery-status handler), and nothing validated
// the length before the INSERT, so any note over 45 chars crashed with an
// unhandled MySQL "data too long" error (500) instead of a clean message.
// Widens it to a realistic size. Safe to re-run.
import { sequelize2PetraErp } from "../config/db.js";

const run = async () => {
    try {
        const [[current]] = await sequelize2PetraErp.query(`
            SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InsDelivered' AND COLUMN_NAME = 'InsDeliveredNote'
        `);

        if (!current) {
            console.error("❌ InsDelivered.InsDeliveredNote not found");
            process.exit(1);
        }
        if (current.len >= 500) {
            console.log(`⏭️  InsDeliveredNote already VARCHAR(${current.len}), skipping`);
            process.exit(0);
        }

        await sequelize2PetraErp.query("ALTER TABLE `InsDelivered` MODIFY COLUMN `InsDeliveredNote` VARCHAR(500) NULL");
        console.log("✅ Widened InsDelivered.InsDeliveredNote to VARCHAR(500)");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to widen InsDeliveredNote:", err);
        process.exit(1);
    }
};

run();
