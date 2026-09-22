// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-issued-fields.js
// ------------------------------------------------------
// Adds issuedBy/issuedDate to matWhReservationItems (models/
// MatWhReservationItem.js) -- the new storekeeper-issue stage (WM 10-22),
// split out from what Confirm Reservation already does (production-
// supervisor approval, WM 10-21). Plain ALTER on an existing table,
// idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// add-matwh-reservation-requested-by.js.
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
        await addColumnIfMissing("matWhReservationItems", "issuedBy", "`issuedBy` INT NULL");
        await addColumnIfMissing("matWhReservationItems", "issuedDate", "`issuedDate` DATETIME NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add issuedBy/issuedDate columns:", err);
        process.exit(1);
    }
};

run();
