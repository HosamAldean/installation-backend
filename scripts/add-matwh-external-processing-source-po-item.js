// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-source-po-item.js
// ------------------------------------------------------
// Adds sourcePurchaseOrderItemId to matWhExternalProcessing
// (models/MatWhExternalProcessing.js) -- follow-up to the mill-finish
// coating workflow, 2026-09-23: the draft coating job for a shortfall line
// now gets created at RESERVATION-CONFIRM time (services/
// matWhReservations.js) instead of waiting for the mill-finish goods
// receipt, so the storekeeper/coating team can see the request is coming
// before the raw material even arrives. That earlier creation point needs a
// direct, unambiguous FK back to the shortfall's own MatWhPurchaseOrderItem
// so a later goods receipt (routes/materialsWarehousePurchasing.js's
// POST /goods-receipts) can find THIS SAME draft row and accumulate its
// qtySent (handles a shortfall PO received across more than one goods
// receipt) instead of creating a duplicate job per receipt.
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

const run = async () => {
    try {
        if (await columnExists("matWhExternalProcessing", "sourcePurchaseOrderItemId")) {
            console.log("- matWhExternalProcessing.sourcePurchaseOrderItemId already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhExternalProcessing` ADD COLUMN `sourcePurchaseOrderItemId` INT NULL",
            );
            console.log("✅ Added matWhExternalProcessing.sourcePurchaseOrderItemId");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing.sourcePurchaseOrderItemId:", err);
        process.exit(1);
    }
};

run();
