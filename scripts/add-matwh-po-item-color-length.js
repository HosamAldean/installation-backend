// ------------------------------------------------------
// backend/scripts/add-matwh-po-item-color-length.js
// ------------------------------------------------------
// Adds color/lengthMm to matWhPurchaseOrderItems (models/
// MatWhPurchaseOrderItem.js) -- same aluminum-only fields
// matWhReservationItems already has (add-matwh-reservation-item-color-
// length.js), so a manually-created PO for an aluminum item can specify a
// coating color too. Plain ALTER on an existing table, idempotent (checks
// INFORMATION_SCHEMA.COLUMNS first), same pattern as every other migration
// script in this directory.
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
        await addColumnIfMissing("matWhPurchaseOrderItems", "color", "`color` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhPurchaseOrderItems", "lengthMm", "`lengthMm` FLOAT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add color/lengthMm columns:", err);
        process.exit(1);
    }
};

run();
