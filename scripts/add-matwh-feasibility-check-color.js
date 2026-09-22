// ------------------------------------------------------
// backend/scripts/add-matwh-feasibility-check-color.js
// ------------------------------------------------------
// Adds `color` to matWhFeasibilityChecks (models/MatWhFeasibilityCheck.js)
// -- Phase 3 of the 2026-09-22 Materials Warehouse capability audit: once
// getAvailableToReserve becomes color-aware (services/matWhLedger.js), a
// feasibility check against a specific painted color should record what
// color it actually checked, not just a bare item+qty. Plain ALTER on an
// existing table, idempotent (checks INFORMATION_SCHEMA.COLUMNS first),
// same pattern as every other add-matwh-*.js script.
import { sequelizeUtf8 } from "../config/db.js";

const columnExists = async (table, column) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
};

const addColumnIfMissing = async (table, column, ddl) => {
    if (await columnExists(table, column)) {
        console.log(`- ${table}.${column} already exists, skipping`);
        return;
    }
    await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`✅ Added ${table}.${column}`);
};

const run = async () => {
    try {
        await addColumnIfMissing("matWhFeasibilityChecks", "color", "`color` VARCHAR(50) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhFeasibilityChecks.color:", err);
        process.exit(1);
    }
};

run();
