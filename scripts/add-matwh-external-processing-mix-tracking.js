// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-mix-tracking.js
// ------------------------------------------------------
// Adds notes/estimatedDeliveryDate/confirmedReceivedAt/confirmedReceivedBy/
// actualFinishDate to matWhExternalProcessing (models/
// MatWhExternalProcessing.js) -- per direct request, tracking Mix's (the
// coating vendor's) own progress reporting on a 'sent' job (they got the
// batch, an ETA, then it's actually done) separately from the physical
// send/receive-back ledger movements, which stay unchanged.
//
// Idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// every other add-matwh-*.js script.
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
        await addColumnIfMissing("matWhExternalProcessing", "notes", "`notes` TEXT NULL");
        await addColumnIfMissing("matWhExternalProcessing", "estimatedDeliveryDate", "`estimatedDeliveryDate` DATE NULL");
        await addColumnIfMissing("matWhExternalProcessing", "confirmedReceivedAt", "`confirmedReceivedAt` DATETIME NULL");
        await addColumnIfMissing("matWhExternalProcessing", "confirmedReceivedBy", "`confirmedReceivedBy` INT NULL");
        await addColumnIfMissing("matWhExternalProcessing", "actualFinishDate", "`actualFinishDate` DATE NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing Mix-tracking fields:", err);
        process.exit(1);
    }
};

run();
