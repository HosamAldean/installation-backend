// ------------------------------------------------------
// backend/scripts/add-matwh-item-barcode-details-photo.js
// ------------------------------------------------------
// Adds barcode/details/detailsAr/photoUrl to matWhItems, and barcode to
// matWhProfileCatalog (models/MatWhItem.js, models/MatWhProfileCatalog.js) --
// both tables already exist (created via their own .sync() in
// create-materials-warehouse-tables.js / create-materials-warehouse-profile-
// tables.js), so this is a plain ALTER, not a create. Checks
// INFORMATION_SCHEMA.COLUMNS first and only adds what's missing, same
// idempotent, safe-to-re-run style as create-item-profile-table.js.
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
        await addColumnIfMissing("matWhItems", "barcode", "`barcode` VARCHAR(50) NULL UNIQUE");
        await addColumnIfMissing("matWhItems", "details", "`details` TEXT NULL");
        await addColumnIfMissing("matWhItems", "detailsAr", "`detailsAr` TEXT NULL");
        await addColumnIfMissing("matWhItems", "photoUrl", "`photoUrl` VARCHAR(255) NULL");
        await addColumnIfMissing("matWhProfileCatalog", "barcode", "`barcode` VARCHAR(50) NULL UNIQUE");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add item barcode/details/photo columns:", err);
        process.exit(1);
    }
};

run();
