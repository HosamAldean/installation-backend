// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-issued-barcode.js
// ------------------------------------------------------
// Adds issuedBarcode to matWhReservationItems (models/
// MatWhReservationItem.js) -- the specific physical piece's own barcode,
// recorded by the storekeeper at issue time (WM 10-22), distinct from
// matWhItems.barcode which is the item-TYPE's barcode shared by every
// piece of that profile. Plain ALTER on an existing table, idempotent
// (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// add-matwh-reservation-item-issued-fields.js.
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
        await addColumnIfMissing("matWhReservationItems", "issuedBarcode", "`issuedBarcode` VARCHAR(50) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add issuedBarcode column:", err);
        process.exit(1);
    }
};

run();
