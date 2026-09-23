// ------------------------------------------------------
// backend/scripts/import-matwh-opening-balances-from-petrastock.js
// ------------------------------------------------------
// One-time bulk seed of Materials Warehouse opening balances from
// PetraStock (SQL Server `erp` pool), the same old-system table this
// module's original item import already used for item master data
// (import-matwh-items-from-petrastock.js). PetraStock's `qty` column is a
// live current-stock snapshot per item+store -- `store` is the parent
// cluster (100 installation / 200 accessories / 300 aluminum) and `store1`
// is the real specific store code, which maps 1:1 onto real matWhStores
// rows already seeded from Alpha's InvStoresMF.
//
// Installation + Aluminum only -- Accessories opening balances come from
// Alpha's own transaction history instead (direct decision, 2026-09-23:
// see import-matwh-opening-balances-from-alpha-accessories.js), since the
// user specifically wanted Alpha as the accessories source and Alpha has
// no ready-made current-balance table to read it from directly.
//
// READ-ONLY against the old system: one SELECT against SQL Server, no
// writes there. Writes only ever land in matWhStockLedger (MySQL), via the
// exact same postLedgerMovement + applyReceiptCost path
// POST /materials-warehouse/opening-balance itself uses -- this script is
// a bulk version of that one-item-at-a-time route, not a different code
// path. Same guard, too: an item+store that already has ANY real ledger
// activity is skipped, never overwritten -- opening balances are a
// before-go-live, one-time action.
//
// PetraStock has no cost/price column at all, so every row seeds qty only
// (unitCost omitted -- matWhItemCost starts uninitialized for these items,
// same as it would for a real opening-balance entered with no cost via the
// UI). Confirmed live 2026-09-23: 7,872 PetraStock rows, 7,516 distinct
// item codes, of which 3,557 match a real matWhItems row (the rest --
// mostly fastener/consumable-looking codes, e.g. "SCWMM-12C*8M" -- were
// never picked up by the earlier Alpha-based item sync and are reported,
// not silently dropped, so they can be reviewed separately). 2 duplicate
// (itemno, store1) pairs exist in PetraStock itself -- summed rather than
// picking one arbitrarily, since both look like real split entries.
//
// Safe to re-run: every item+store this run successfully seeds now has
// real ledger activity, so a second run skips it via the same guard the
// live route uses. Pass DRY_RUN=1 to preview counts without writing
// anything.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { postLedgerMovement } from "../services/matWhLedger.js";

// Accessories (201/202/203) are seeded separately, from Alpha's own
// transaction history instead -- see
// import-matwh-opening-balances-from-alpha-accessories.js. Only
// Installation + Aluminum use PetraStock's qty snapshot here, per direct
// decision (confirmed 2026-09-23).
const TARGET_STORE_CODES = ["101", "102", "301", "302", "303"];
const DRY_RUN = process.env.DRY_RUN === "1";

const run = async () => {
    const erp = await getSqlPool("erp");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await erp.request().query(`
        SELECT itemno, store1, SUM(qty) AS qty
        FROM PetraStock
        WHERE store1 IN (${TARGET_STORE_CODES.join(",")})
        GROUP BY itemno, store1
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} distinct item+store rows from PetraStock (${TARGET_STORE_CODES.length} target stores), old system untouched (SELECT only).`);

    const stores = await MatWhStore.findAll({ where: { storeCode: TARGET_STORE_CODES } });
    const storeIdByCode = new Map(stores.map((s) => [s.storeCode, s.id]));

    const itemCodes = [...new Set(rows.map((r) => String(r.itemno || "").trim()).filter(Boolean))];
    const items = await MatWhItem.findAll({ where: { itemCode: itemCodes } });
    const itemIdByCode = new Map(items.map((i) => [i.itemCode, i.id]));

    let created = 0;
    let skippedUnmatchedItem = 0;
    let skippedAlreadyHasActivity = 0;
    let skippedZeroOrInvalidQty = 0;
    const unmatchedCodes = new Set();

    for (const row of rows) {
        const itemCode = String(row.itemno || "").trim();
        const storeCode = String(row.store1);
        const qty = Number(row.qty);

        const itemId = itemIdByCode.get(itemCode);
        const storeId = storeIdByCode.get(storeCode);
        if (!itemId) { skippedUnmatchedItem++; unmatchedCodes.add(itemCode); continue; }
        if (!storeId) { skippedUnmatchedItem++; continue; } // shouldn't happen, all 8 codes confirmed to exist
        if (!Number.isFinite(qty) || qty <= 0) { skippedZeroOrInvalidQty++; continue; }

        const existingActivity = await MatWhStockLedger.count({ where: { storeId, itemId } });
        if (existingActivity > 0) { skippedAlreadyHasActivity++; continue; }

        if (!DRY_RUN) {
            await postLedgerMovement({
                storeId, itemId, qty, direction: "in", docType: "opening_balance",
                refType: "cutover", refId: null, performedBy: null,
            });
        }
        created++;
    }

    console.log(`\n${DRY_RUN ? "[DRY RUN] Would create" : "✅ Created"}: ${created} opening-balance ledger rows`);
    console.log(`Skipped -- item not in matWhItems: ${skippedUnmatchedItem}`);
    console.log(`Skipped -- item+store already has real ledger activity: ${skippedAlreadyHasActivity}`);
    console.log(`Skipped -- zero/invalid qty: ${skippedZeroOrInvalidQty}`);
    console.log(`\nUnmatched item codes (${unmatchedCodes.size} distinct), first 30:`);
    console.log([...unmatchedCodes].slice(0, 30).join(", "));
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Import failed:", err);
    process.exit(1);
});
