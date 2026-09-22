// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-issue-purpose.js
// ------------------------------------------------------
// Adds issuePurpose to matWhReservationItems (models/MatWhReservationItem.js)
// -- Phase 4 of the 2026-09-22 Materials Warehouse capability audit, gap #4a
// ("no field anywhere records why material is being issued"). Recorded by
// the storekeeper at issue time, same treatment as issuedBarcode (add-matwh-
// reservation-item-issued-barcode.js) -- set once, never guessed. Plain
// VARCHAR, not a DB enum -- allowed values ('factory_production' /
// 'general_purpose') are enforced at the route level and documented in the
// model comment, same convention as every other fixed-vocabulary column in
// this module (status, docType, etc). Idempotent (checks INFORMATION_SCHEMA
// .COLUMNS first), same pattern as every other add-matwh-*.js script.
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
        await addColumnIfMissing("matWhReservationItems", "issuePurpose", "`issuePurpose` VARCHAR(20) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add issuePurpose column:", err);
        process.exit(1);
    }
};

run();
