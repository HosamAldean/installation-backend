// ------------------------------------------------------
// backend/scripts/import-matwh-opening-balances-from-alpha-accessories.js
// ------------------------------------------------------
// One-time bulk seed of Materials Warehouse opening balances for the
// ACCESSORIES cluster (stores 201/202/203) from Alpha itself (SQL Server
// `erp` pool), per direct decision 2026-09-23 -- the user specifically
// wanted Alpha as the accessories source, not PetraStock (used instead for
// Installation + Aluminum, see the sibling
// import-matwh-opening-balances-from-petrastock.js).
//
// Alpha has no ready-made current-balance table (checked and ruled out:
// OT_StoreItemsQty and Stock are both empty, InvStockTaking only has 177
// rows -- a one-off physical count, not full coverage). Instead this
// computes a live balance the same way our own matWhStockLedger does: sum
// signed Qty across every transaction. Verified live before writing this:
//   - InvDailyDF (122,042 rows) and InvHistoryDF (473,867 rows) have ZERO
//     overlapping rows (matched on VouYear+VouType+VouNo+StoreNo+ItemNo+
//     ItemSer) despite their VouDate ranges overlapping -- genuinely
//     disjoint, safe to UNION ALL with no double-counting.
//   - Qty already carries a consistent sign per VouType, never mixed:
//     VouType 1/4/0 always positive (receipts), VouType 11 always negative
//     (issues/sales), VouType 5/12 are a matched transfer pair (5 positive
//     at the receiving store, 12 negative at the sending store, both legs
//     always carrying the same |Qty| and a populated ToStoreNo) -- a plain
//     SUM(Qty) per StoreNo+ItemNo nets everything out correctly with no
//     VouType-specific sign handling needed.
//   - RejFlag is always NULL across the whole table (confirmed via GROUP
//     BY) -- never populated/used, nothing to filter on there.
//   - Item-code match quality here is high: 5,886 of 5,898 distinct
//     ItemNo values under stores 201/202/203 match a real matWhItems row
//     case-insensitively (99.8%) -- far better than PetraStock's ~47% for
//     the same cluster, which is exactly why the user wanted Alpha here.
//
// READ-ONLY against Alpha: two SELECTs (one per transaction table, unioned
// in application code rather than a cross-database SQL UNION to keep the
// query simple), no writes there. Writes only ever land in
// matWhStockLedger (MySQL), via the same postLedgerMovement path
// POST /materials-warehouse/opening-balance itself uses. Same guard: an
// item+store that already has ANY real ledger activity is skipped, never
// overwritten. No cost data available here either (same as the PetraStock
// script) -- qty only, unitCost omitted.
//
// Safe to re-run: every item+store this seeds now has real ledger
// activity, so a second run skips it via the same guard. Pass DRY_RUN=1
// to preview counts without writing anything.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { postLedgerMovement } from "../services/matWhLedger.js";

const ACCESSORIES_STORE_NOS = [201, 202, 203];
const DRY_RUN = process.env.DRY_RUN === "1";

const run = async () => {
    const erp = await getSqlPool("erp");

    // The only two queries this script sends to SQL Server -- read-only.
    // Summed server-side per table first (cheaper than pulling 470k+ raw
    // rows over the wire), combined in JS below.
    const dailyResult = await erp.request().query(`
        SELECT StoreNo, ItemNo, SUM(Qty) AS qty
        FROM InvDailyDF
        WHERE StoreNo IN (${ACCESSORIES_STORE_NOS.join(",")})
        GROUP BY StoreNo, ItemNo
    `);
    const historyResult = await erp.request().query(`
        SELECT StoreNo, ItemNo, SUM(Qty) AS qty
        FROM InvHistoryDF
        WHERE StoreNo IN (${ACCESSORIES_STORE_NOS.join(",")})
        GROUP BY StoreNo, ItemNo
    `);
    console.log(`Read ${dailyResult.recordset.length} grouped rows from InvDailyDF + ${historyResult.recordset.length} from InvHistoryDF (accessories stores only), old system untouched (SELECT only).`);

    // Combine both sources into one net-qty-per-(store,item) map.
    const netByKey = new Map(); // `${storeNo}:${itemNo}` -> qty
    for (const row of [...dailyResult.recordset, ...historyResult.recordset]) {
        const itemNo = String(row.ItemNo || "").trim();
        if (!itemNo) continue;
        const key = `${row.StoreNo}:${itemNo.toUpperCase()}`;
        const existing = netByKey.get(key);
        netByKey.set(key, {
            storeNo: row.StoreNo,
            itemNoOriginalCase: existing?.itemNoOriginalCase ?? itemNo,
            qty: (existing?.qty ?? 0) + Number(row.qty),
        });
    }

    const stores = await MatWhStore.findAll({ where: { storeCode: ACCESSORIES_STORE_NOS.map(String) } });
    const storeIdByCode = new Map(stores.map((s) => [s.storeCode, s.id]));

    // Case-insensitive match against matWhItems (Alpha's own casing is
    // inconsistent -- same lesson as every prior Alpha-sourced import this
    // session).
    const allItems = await MatWhItem.findAll({ attributes: ["id", "itemCode"] });
    const itemIdByUpperCode = new Map(allItems.map((i) => [i.itemCode.toUpperCase(), i.id]));

    let created = 0;
    let skippedUnmatchedItem = 0;
    let skippedAlreadyHasActivity = 0;
    let skippedZeroOrNegativeQty = 0;
    const unmatchedCodes = new Set();

    for (const { storeNo, itemNoOriginalCase, qty } of netByKey.values()) {
        const itemId = itemIdByUpperCode.get(itemNoOriginalCase.toUpperCase());
        const storeId = storeIdByCode.get(String(storeNo));
        if (!itemId) { skippedUnmatchedItem++; unmatchedCodes.add(itemNoOriginalCase); continue; }
        if (!storeId) { skippedUnmatchedItem++; continue; } // shouldn't happen, all 3 codes confirmed to exist

        // A net balance can legitimately come out zero or negative after
        // summing years of real-world data-entry gaps (an issue posted
        // before its matching receipt, etc.) -- not something to guess-fix
        // here, just skip. Only a genuinely positive current balance is a
        // safe opening-balance candidate.
        if (!Number.isFinite(qty) || qty <= 0) { skippedZeroOrNegativeQty++; continue; }

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
    console.log(`Skipped -- net qty zero or negative: ${skippedZeroOrNegativeQty}`);
    console.log(`\nUnmatched item codes (${unmatchedCodes.size} distinct):`);
    console.log([...unmatchedCodes].join(", "));
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Import failed:", err);
    process.exit(1);
});
