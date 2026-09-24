// ------------------------------------------------------
// backend/scripts/add-matwh-feasibility-check-length.js
// ------------------------------------------------------
// Adds matWhFeasibilityChecks.lengthMm -- companion to the existing color
// column, added when Phase 3 gave availability checks a color dimension
// but length wasn't a stock dimension yet (that came later, Phase 4/the
// item-variant work). A real gap: the feasibility-check availability query
// already threads lengthMm through getAvailableToReserve everywhere else,
// this record just never stored what length was actually checked. Same
// "omitted = pooled, explicit = narrowed" convention as everywhere else.
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
        if (await columnExists("matWhFeasibilityChecks", "lengthMm")) {
            console.log("- matWhFeasibilityChecks.lengthMm already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhFeasibilityChecks` ADD COLUMN `lengthMm` FLOAT NULL",
            );
            console.log("✅ Added matWhFeasibilityChecks.lengthMm");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhFeasibilityChecks.lengthMm:", err);
        process.exit(1);
    }
};

run();
