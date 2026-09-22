// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-header-transfer-fields.js
// ------------------------------------------------------
// Adds previousProjectId/previousProjectNo/previousProjectName/
// transferredBy/transferredDate to matWhReservationHeaders (models/
// MatWhReservationHeader.js) -- lets a reservation's project attribution
// be reassigned (per the 2026-09-22 Materials Warehouse capability audit's
// "transfer between projects" gap) while keeping a one-step-back audit
// trail of what it was transferred FROM, same "previous state on the row,
// not a full history table" convention as MatWhPurchaseOrder's own
// storekeeperConfirmedBy/managerConfirmedBy fields. Plain ALTER on an
// existing table, idempotent (checks INFORMATION_SCHEMA.COLUMNS first),
// same pattern as every other add-matwh-*.js script.
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
        await addColumnIfMissing("matWhReservationHeaders", "previousProjectId", "`previousProjectId` INT NULL");
        await addColumnIfMissing("matWhReservationHeaders", "previousProjectNo", "`previousProjectNo` VARCHAR(50) NULL");
        await addColumnIfMissing("matWhReservationHeaders", "previousProjectName", "`previousProjectName` VARCHAR(255) NULL");
        await addColumnIfMissing("matWhReservationHeaders", "transferredBy", "`transferredBy` INT NULL");
        await addColumnIfMissing("matWhReservationHeaders", "transferredDate", "`transferredDate` DATETIME NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add reservation transfer columns:", err);
        process.exit(1);
    }
};

run();
