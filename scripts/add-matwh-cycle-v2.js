// ------------------------------------------------------
// backend/scripts/add-matwh-cycle-v2.js
// ------------------------------------------------------
// Columns for the material request cycle v2 (2026-11-04):
//   - matWhReservationHeaders: the store manager approves/rejects a new
//     request before any store sees it (status 'pending_store_mgr')
//   - matWhReservationItems: production's issue request against a
//     project's reservation line (the store issues only requested lines),
//     and the line a partial request was split off from
//   - matWhProjectPlanItems: when production requested the order line
// All nullable, so existing rows and the older server are unaffected.
// Plain ALTERs, idempotent, same pattern as add-matwh-approvals.js.
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
    ["matWhReservationHeaders", "storeManagerApprovedBy", "`storeManagerApprovedBy` INT NULL"],
    ["matWhReservationHeaders", "storeManagerApprovedDate", "`storeManagerApprovedDate` DATETIME NULL"],
    ["matWhReservationHeaders", "storeManagerRejectedBy", "`storeManagerRejectedBy` INT NULL"],
    ["matWhReservationHeaders", "storeManagerRejectedDate", "`storeManagerRejectedDate` DATETIME NULL"],
    ["matWhReservationHeaders", "storeManagerRejectionReason", "`storeManagerRejectionReason` VARCHAR(500) NULL"],
    ["matWhReservationItems", "issueRequestedBy", "`issueRequestedBy` INT NULL"],
    ["matWhReservationItems", "issueRequestedDate", "`issueRequestedDate` DATETIME NULL"],
    ["matWhReservationItems", "issueRequestPlanId", "`issueRequestPlanId` INT NULL"],
    ["matWhReservationItems", "issueRequestPlanItemId", "`issueRequestPlanItemId` INT NULL"],
    ["matWhReservationItems", "splitFromLineId", "`splitFromLineId` INT NULL"],
    ["matWhProjectPlanItems", "requestedBy", "`requestedBy` INT NULL"],
    ["matWhProjectPlanItems", "requestedDate", "`requestedDate` DATETIME NULL"],
];

const run = async () => {
    try {
        for (const [table, column, ddl] of COLUMNS) await addColumnIfMissing(table, column, ddl);
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add cycle v2 columns:", err);
        process.exit(1);
    }
};

run();
