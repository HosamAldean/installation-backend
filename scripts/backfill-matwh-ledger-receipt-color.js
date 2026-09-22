// ------------------------------------------------------
// backend/scripts/backfill-matwh-ledger-receipt-color.js
// ------------------------------------------------------
// One-time backfill for Phase 3 of the 2026-09-22 Materials Warehouse
// capability audit: matWhStockLedger.color (add-matwh-stock-ledger-color.js)
// didn't exist when earlier goods receipts posted, so every historical
// docType='receipt' row has color=NULL even where the receiving PO line had
// a real color. Recovers it by joining refId (matWhGoodsReceiptItems.id,
// refType='goods_receipt_item') -> poItemId -> matWhPurchaseOrderItems.color
// -- the exact same lookup POST /goods-receipts itself does live for a new
// receipt (routes/materialsWarehousePurchasing.js).
//
// Guarded by `l.color IS NULL`, so safe to re-run -- a second run updates
// zero rows. Rows with no traceable poItemId (manual/unmatched receipts) or
// a genuinely colorless PO line (mill-finish/non-ALM) stay NULL, same as a
// live receipt would leave them -- not a gap this script is meant to close.
import { sequelizeUtf8 } from "../config/db.js";

const run = async () => {
    try {
        const [result] = await sequelizeUtf8.query(`
            UPDATE matWhStockLedger l
            JOIN matWhGoodsReceiptItems gri ON gri.id = l.refId
            JOIN matWhPurchaseOrderItems poi ON poi.id = gri.poItemId
            SET l.color = poi.color
            WHERE l.docType = 'receipt'
              AND l.refType = 'goods_receipt_item'
              AND l.color IS NULL
              AND poi.color IS NOT NULL
        `);
        console.log(`✅ Backfilled color on ${result.affectedRows ?? 0} historical receipt ledger row(s)`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Backfill failed:", err);
        process.exit(1);
    }
};

run();
