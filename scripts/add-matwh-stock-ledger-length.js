// ------------------------------------------------------
// backend/scripts/add-matwh-stock-ledger-length.js
// ------------------------------------------------------
// Adds matWhStockLedger.lengthMm -- companion to Phase 3's color column
// (add-matwh-stock-ledger-color.js). Reservation/PO lines have carried
// lengthMm since Phase 4, but it was never actually a stock dimension --
// availability checks only ever filtered by color, length was purely
// informational. Same-day design discussion (2026-09-23, aluminum variant
// barcodes): a change in length legitimately means a different physical
// piece, same as color does, so it needs the same treatment.
//
// Convention, simpler than color's: omitted (undefined) means "don't
// filter by length" (pooled across all lengths, every existing caller's
// exact behavior today) -- an explicit numeric value narrows to that
// length specifically. Unlike color, there's no length equivalent of
// "MILL"/raw needing special aliasing -- a plain optional dimension.
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
        if (await columnExists("matWhStockLedger", "lengthMm")) {
            console.log("- matWhStockLedger.lengthMm already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhStockLedger` ADD COLUMN `lengthMm` FLOAT NULL",
            );
            console.log("✅ Added matWhStockLedger.lengthMm");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhStockLedger.lengthMm:", err);
        process.exit(1);
    }
};

run();
