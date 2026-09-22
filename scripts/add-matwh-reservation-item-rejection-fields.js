// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-rejection-fields.js
// ------------------------------------------------------
// Adds rejectedBy/rejectedDate/rejectionReason to matWhReservationItems
// (models/MatWhReservationItem.js) -- the new per-store "reject with
// reason" path (WM 10-21), alongside the existing per-line confirm. Plain
// ALTER on an existing table, idempotent (checks INFORMATION_SCHEMA.
// COLUMNS first), same pattern as the other matWhReservationItems
// migrations this session.
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
        await addColumnIfMissing("matWhReservationItems", "rejectedBy", "`rejectedBy` INT NULL");
        await addColumnIfMissing("matWhReservationItems", "rejectedDate", "`rejectedDate` DATETIME NULL");
        await addColumnIfMissing("matWhReservationItems", "rejectionReason", "`rejectionReason` VARCHAR(500) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add rejection columns:", err);
        process.exit(1);
    }
};

run();
