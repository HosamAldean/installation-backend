// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-source-color.js
// ------------------------------------------------------
// Adds matWhExternalProcessing.sourceColor -- what color is actually being
// sent out on a coating job. Every job before this column existed sent
// mill-finish only (color: null implicitly, never stored); a storekeeper
// can now pick a different already-in-stock color at confirm-send time
// instead (routes/materialsWarehouseOperations.js's POST /confirm-send),
// so the job needs somewhere to remember which one it actually was.
//
// Idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// every other add-matwh-*.js script.
import { sequelizeUtf8 } from "../config/db.js";

const columnExists = async (table, column) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
};

const run = async () => {
    try {
        if (await columnExists("matWhExternalProcessing", "sourceColor")) {
            console.log("- matWhExternalProcessing.sourceColor already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhExternalProcessing` ADD COLUMN `sourceColor` VARCHAR(50) NULL",
            );
            console.log("✅ Added matWhExternalProcessing.sourceColor");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing.sourceColor:", err);
        process.exit(1);
    }
};

run();
