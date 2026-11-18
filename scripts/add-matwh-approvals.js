// ------------------------------------------------------
// backend/scripts/add-matwh-approvals.js
// ------------------------------------------------------
// Approval columns for the material request cycle (2026-10-29):
//   - matWhReservationHeaders: production manager approve/reject
//   - matWhReservationItems: store manager approval before issue
//   - matWhExternalProcessing: store manager approval of coating requests
// The status columns default to 'not_required', so rows created before
// this (and an older server still writing rows) keep working unchanged.
// Plain ALTERs, idempotent, same pattern as add-matwh-reservation-
// requested-by.js.
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

const COLUMNS = [
    ["matWhReservationHeaders", "productionApprovedBy", "`productionApprovedBy` INT NULL"],
    ["matWhReservationHeaders", "productionApprovedDate", "`productionApprovedDate` DATETIME NULL"],
    ["matWhReservationHeaders", "productionRejectedBy", "`productionRejectedBy` INT NULL"],
    ["matWhReservationHeaders", "productionRejectedDate", "`productionRejectedDate` DATETIME NULL"],
    ["matWhReservationHeaders", "productionRejectionReason", "`productionRejectionReason` VARCHAR(500) NULL"],
    ["matWhReservationItems", "managerApprovalStatus", "`managerApprovalStatus` VARCHAR(20) NOT NULL DEFAULT 'not_required'"],
    ["matWhReservationItems", "managerApprovedBy", "`managerApprovedBy` INT NULL"],
    ["matWhReservationItems", "managerApprovedDate", "`managerApprovedDate` DATETIME NULL"],
    ["matWhExternalProcessing", "approvalStatus", "`approvalStatus` VARCHAR(20) NOT NULL DEFAULT 'not_required'"],
    ["matWhExternalProcessing", "approvedBy", "`approvedBy` INT NULL"],
    ["matWhExternalProcessing", "approvedDate", "`approvedDate` DATETIME NULL"],
    ["matWhExternalProcessing", "rejectedBy", "`rejectedBy` INT NULL"],
    ["matWhExternalProcessing", "rejectedDate", "`rejectedDate` DATETIME NULL"],
    ["matWhExternalProcessing", "rejectionReason", "`rejectionReason` VARCHAR(500) NULL"],
];

const run = async () => {
    try {
        for (const [table, column, ddl] of COLUMNS) await addColumnIfMissing(table, column, ddl);
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add approval columns:", err);
        process.exit(1);
    }
};

run();
