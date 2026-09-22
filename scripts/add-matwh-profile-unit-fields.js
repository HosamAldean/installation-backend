// ------------------------------------------------------
// backend/scripts/add-matwh-profile-unit-fields.js
// ------------------------------------------------------
// Adds baseUnit/altUnit/conversionFactor/minQty to matWhProfileCatalog
// (models/MatWhProfileCatalog.js -- ALTER, table already exists), needed
// before backfill-matwh-profile-from-alpha-by-name.js can populate them.
// Idempotent (column-existence-checked). Safe to re-run.
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
    await addColumnIfMissing("matWhProfileCatalog", "baseUnit", "`baseUnit` VARCHAR(20) NULL");
    await addColumnIfMissing("matWhProfileCatalog", "altUnit", "`altUnit` VARCHAR(20) NULL");
    await addColumnIfMissing("matWhProfileCatalog", "conversionFactor", "`conversionFactor` FLOAT NULL");
    await addColumnIfMissing("matWhProfileCatalog", "minQty", "`minQty` FLOAT NULL");
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
