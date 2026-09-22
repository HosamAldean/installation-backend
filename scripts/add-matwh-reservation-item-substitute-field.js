// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-substitute-field.js
// ------------------------------------------------------
// Adds substitutesLineId to matWhReservationItems (models/
// MatWhReservationItem.js) -- the "compensation options" gap from the
// 2026-09-22 Materials Warehouse capability audit: when a line has a real
// shortfall, this lets a storekeeper offer a different item/color/length
// that IS actually in stock instead of only ever waiting on the
// shortfall's auto-generated PO. A substitute is modeled as its own new
// reservation line on the same header (own item/color/length/qty,
// confirmed immediately since availability is checked at substitution
// time), linked back to the shortfall line it covers via this nullable
// self-referencing FK. Plain ALTER on an existing table, idempotent
// (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as every other
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
        await addColumnIfMissing("matWhReservationItems", "substitutesLineId", "`substitutesLineId` INT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add substitutesLineId column:", err);
        process.exit(1);
    }
};

run();
