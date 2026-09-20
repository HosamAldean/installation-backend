// ------------------------------------------------------
// backend/scripts/add-goods-receipt-item-ledger-link.js
// ------------------------------------------------------
// Adds ledgerEntryId to matWhGoodsReceiptItems (created by WH.2's
// create-materials-warehouse-purchasing-tables.js, before matWhStockLedger
// existed). Checks INFORMATION_SCHEMA.COLUMNS first -- same pattern as
// add-transport-payment-columns.js. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelizeUtf8.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'matWhGoodsReceiptItems'
        `);
        const existingNames = new Set(existing.map((r) => r.COLUMN_NAME));

        if (existingNames.has("ledgerEntryId")) {
            console.log("⏭️  ledgerEntryId already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhGoodsReceiptItems` ADD COLUMN `ledgerEntryId` INT NULL"
            );
            console.log("✅ Added ledgerEntryId");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add ledgerEntryId:", err);
        process.exit(1);
    }
};

run();
