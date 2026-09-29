// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-request-ack.js
// ------------------------------------------------------
// Adds requestAcknowledgedAt/requestAcknowledgedBy to
// matWhExternalProcessing (models/MatWhExternalProcessing.js) -- per
// direct request, Mix must be able to acknowledge the painting REQUEST
// itself (while the job is still 'draft', once a vendor's been named via
// POST .../request-vendor but before anything physically ships), a
// separate and earlier confirmation from confirmedReceivedAt (the
// physical materials actually arriving once 'sent').
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
        await addColumnIfMissing("matWhExternalProcessing", "requestAcknowledgedAt", "`requestAcknowledgedAt` DATETIME NULL");
        await addColumnIfMissing("matWhExternalProcessing", "requestAcknowledgedBy", "`requestAcknowledgedBy` INT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing request-ack fields:", err);
        process.exit(1);
    }
};

run();
