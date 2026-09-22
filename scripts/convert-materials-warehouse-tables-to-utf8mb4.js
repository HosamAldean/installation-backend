// ------------------------------------------------------
// scripts/convert-materials-warehouse-tables-to-utf8mb4.js
// ------------------------------------------------------
// Every matWh* table (and the extended `vendors` table) was created via
// sequelize2PetraErp, whose connection-level `define` defaults to
// latin1/latin1_swedish_ci -- the right choice for models reading Petra's
// pre-existing legacy data, but wrong for these genuinely new tables.
// Writing real Arabic text through a latin1-negotiated connection silently
// truncates each UTF-16 code unit to its low byte (confirmed live:
// storeNameAr stored as literal ASCII garbage, not even valid mojibake).
//
// Models now point at sequelizeUtf8 instead (utf8mb4 connection), but that
// only affects new tables -- these already exist with latin1 columns.
// CONVERT TO CHARACTER SET actually re-encodes stored bytes (unlike a bare
// column-type ALTER), which is correct here since every affected column so
// far only ever held plain ASCII (Store Code, Item Code, English names) or
// the one known-corrupted Arabic value -- there's no real UTF-8-as-latin1
// legacy data in these brand-new tables to preserve.
//
// Idempotent: converting an already-utf8mb4 table is a harmless no-op.
import { sequelizeUtf8 } from "../config/db.js";

const TABLES = [
    "matWhStores",
    "matWhItems",
    "matWhUserStoreAssignments",
    "matWhQcCategories",
    "matWhQcResults",
    "matWhPurchaseOrders",
    "matWhPurchaseOrderItems",
    "matWhGoodsReceipts",
    "matWhGoodsReceiptItems",
    "matWhSupplierInvoices",
    "matWhSupplierInvoiceItems",
    "matWhStockLedger",
    "matWhReservations",
    "matWhFeasibilityChecks",
    "matWhExternalProcessing",
    "matWhItemCost",
    "vendors",
];

const run = async () => {
    try {
        for (const table of TABLES) {
            await sequelizeUtf8.query(
                `ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            console.log(`✅ ${table} converted to utf8mb4`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to convert materials warehouse tables:", err);
        process.exit(1);
    }
};

run();
