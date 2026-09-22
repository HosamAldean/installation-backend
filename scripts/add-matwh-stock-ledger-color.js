// ------------------------------------------------------
// backend/scripts/add-matwh-stock-ledger-color.js
// ------------------------------------------------------
// Adds `color` to matWhStockLedger (models/MatWhStockLedger.js) -- Phase 3
// of the 2026-09-22 Materials Warehouse capability audit: availability
// checks (getPhysicalBalance/getAvailableToReserve/etc, services/
// matWhLedger.js) have never had a color dimension, even though color
// already lives on reservation/PO lines -- a reservation for one painted
// color could silently confirm against a different color's physical
// stock. This column, plus every ledger-writing route passing it, is what
// makes that finally checkable. Plain ALTER on an existing table,
// idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// every other add-matwh-*.js script.
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
        await addColumnIfMissing("matWhStockLedger", "color", "`color` VARCHAR(50) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhStockLedger.color:", err);
        process.exit(1);
    }
};

run();
