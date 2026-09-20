// ------------------------------------------------------
// backend/scripts/add-matwh-po-internal-approval-fields.js
// ------------------------------------------------------
// Adds internalApprovalStatus/storekeeperConfirmedBy/storekeeperConfirmedDate/
// managerConfirmedBy/managerConfirmedDate to matWhPurchaseOrders (models/
// MatWhPurchaseOrder.js) -- the new storekeeper->store-manager->purchasing
// review chain for auto-generated shortfall POs. Plain ALTER on an existing
// table, idempotent (checks INFORMATION_SCHEMA.COLUMNS first). Every
// EXISTING row (manually-created and auto-generated alike, from before this
// chain existed) gets backfilled to 'not_required' -- retroactively
// enforcing the new chain on old auto-generated POs would strand them
// waiting on a confirmation nobody's expecting to give; the chain only
// applies going forward.
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
        await addColumnIfMissing(
            "matWhPurchaseOrders", "internalApprovalStatus",
            "`internalApprovalStatus` VARCHAR(20) NOT NULL DEFAULT 'not_required'",
        );
        await addColumnIfMissing("matWhPurchaseOrders", "storekeeperConfirmedBy", "`storekeeperConfirmedBy` INT NULL");
        await addColumnIfMissing("matWhPurchaseOrders", "storekeeperConfirmedDate", "`storekeeperConfirmedDate` DATETIME NULL");
        await addColumnIfMissing("matWhPurchaseOrders", "managerConfirmedBy", "`managerConfirmedBy` INT NULL");
        await addColumnIfMissing("matWhPurchaseOrders", "managerConfirmedDate", "`managerConfirmedDate` DATETIME NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add PO internal-approval columns:", err);
        process.exit(1);
    }
};

run();
