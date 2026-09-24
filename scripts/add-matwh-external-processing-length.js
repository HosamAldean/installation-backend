// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-length.js
// ------------------------------------------------------
// Adds matWhExternalProcessing.lengthMm -- a coating job's own reservation/
// PO source line has always carried lengthMm, but the job itself never
// did, even though a real barcode-confirmed receive-back (this same-day
// follow-up: "purchase and coating requests need...barcode on the data
// master") needs to know the exact length to resolve the right
// matWhItemVariants row against. Same "omitted = pooled, explicit =
// narrowed" convention as everywhere else.
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
        if (await columnExists("matWhExternalProcessing", "lengthMm")) {
            console.log("- matWhExternalProcessing.lengthMm already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhExternalProcessing` ADD COLUMN `lengthMm` FLOAT NULL",
            );
            console.log("✅ Added matWhExternalProcessing.lengthMm");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing.lengthMm:", err);
        process.exit(1);
    }
};

run();
