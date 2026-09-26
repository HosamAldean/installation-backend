// ------------------------------------------------------
// backend/scripts/add-matwh-writeoff-item-color-length.js
// ------------------------------------------------------
// Adds color/lengthMm to matWhWriteoffRequestItems and
// matWhWriteoffReportItems (models/MatWhWriteoffRequestItem.js,
// MatWhWriteoffReportItem.js) -- the write-off flow was the one real
// stock-movement path this module never threaded color/length through
// (every other movement -- reservations, PO items, goods receipts,
// feasibility checks, cutover opening balance, external processing --
// already has both). Without it, writing off a painted-aluminum item
// posts its ledger movement as color: null (mill-finish), silently
// decrementing the wrong pool instead of the color/length actually
// destroyed. Plain ALTER on existing tables, idempotent (checks
// INFORMATION_SCHEMA.COLUMNS first), same pattern as every other
// migration script in this directory.
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
        await addColumnIfMissing("matWhWriteoffRequestItems", "color", "`color` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhWriteoffRequestItems", "lengthMm", "`lengthMm` FLOAT NULL");
        await addColumnIfMissing("matWhWriteoffReportItems", "color", "`color` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhWriteoffReportItems", "lengthMm", "`lengthMm` FLOAT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add color/lengthMm columns:", err);
        process.exit(1);
    }
};

run();
