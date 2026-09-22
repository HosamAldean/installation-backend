// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-color-length.js
// ------------------------------------------------------
// Adds color/lengthMm to matWhReservationItems (models/
// MatWhReservationItem.js) -- WM 10-21/10-22's aluminum-only "اللون"/
// "الطول" line fields, missing until now. Plain ALTER on an existing
// table, idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same
// pattern as add-matwh-reservation-requested-by.js.
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
        await addColumnIfMissing("matWhReservationItems", "color", "`color` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhReservationItems", "lengthMm", "`lengthMm` FLOAT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add color/lengthMm columns:", err);
        process.exit(1);
    }
};

run();
