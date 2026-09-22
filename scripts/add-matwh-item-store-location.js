// ------------------------------------------------------
// backend/scripts/add-matwh-item-store-location.js
// ------------------------------------------------------
// Adds zone/locationColumn/locationRow to matWhItemStores (models/
// MatWhItemStore.js) -- Phase 4 of the 2026-09-22 Materials Warehouse
// capability audit, gap #9 ("location tracking exists only for Profile
// Store, and only Column/Row -- the main item catalog behind Reservations/
// Purchasing/Receiving has no location fields at all"). Lives on the
// item+store JUNCTION table, not MatWhItem (same item sits in multiple
// stores/bins) or MatWhStore (a store already IS a location -- zone/
// column/row are sub-locations WITHIN one store). Same field names as
// MatWhProfileStock's existing locationColumn/locationRow, for naming
// consistency only -- no relation between the two tables. Describes where
// the item's pooled stock is generally found in that store, not a
// per-physical-unit location (System A has no per-unit tracking at all,
// unlike Profile Store's barcode-per-piece model). Idempotent (checks
// INFORMATION_SCHEMA.COLUMNS first), same pattern as every other
// add-matwh-*.js script.
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
        await addColumnIfMissing("matWhItemStores", "zone", "`zone` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhItemStores", "locationColumn", "`locationColumn` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhItemStores", "locationRow", "`locationRow` VARCHAR(50) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhItemStores location columns:", err);
        process.exit(1);
    }
};

run();
