// ------------------------------------------------------
// backend/scripts/import-matwh-opening-balances-alm-color-variants-from-petrastock.js
// ------------------------------------------------------
// Follow-up to import-matwh-opening-balances-from-petrastock.js, reconciling
// the ~3,958 aluminum item codes that script reported as unmatched (see
// materials_warehouse_module memory, 2026-09-23 opening-balance entry).
//
// Root cause investigated live, not guessed: PetraStock tracks aluminum
// stock in stores 301/302/303 almost entirely under PER-COLOR-VARIANT codes
// of the shape `ALM<SUBCAT>-<COLORCODE>-<PROFILENO>[SUFFIX]`
// (e.g. "ALMLUP-1035J90-1010"), not the bare profile number our own
// matWhItems.itemCode uses (e.g. "1010"). Confirmed live: 0 profile+store
// combinations have BOTH a bare-code PetraStock row and prefixed
// color-variant rows -- these are two disjoint representations, not an
// overlapping double-count risk, and virtually none of stores 301-303's
// stock matched via the bare-code path in the original script (0 of the
// bare ALM-category rows there had any real ledger activity from it).
//
// Color itself is deliberately NOT reconciled or stored here -- PetraStock's
// color-code segment (e.g. "1035J90", "08019", "IVORY", "MIX05/1") does not
// reliably map onto IIT_Petra.colorInfo's real mixCode scheme (tested: exact
// match, "MX"+code match, and prefix match against all 576 real AL mixCodes
// all failed for the overwhelming majority) -- inventing a mapping would be
// guessing at real production data, which this session's own precedent
// (profile-enrichment, barcode backfill) explicitly avoids. Every matching
// profile+store's color-variant quantities are summed into ONE pooled
// opening-balance row instead (color: omitted, same as every other
// opening-balance row this module has ever posted -- none of them are
// color-tagged, see postLedgerMovement's own color param being optional).
// This underrepresents true per-color stock but correctly represents true
// total physical balance per item+store, which is what "opening balance"
// means here; per-color granularity was never tracked for any store by any
// prior pass either.
//
// Profile-number resolution: strip the `ALM<SUBCAT>-<COLORCODE>-` prefix,
// match the remainder against matWhItems.itemCode (category='ALM') exactly
// first, then -- only if that fails -- with a trailing letter suffix
// stripped (e.g. "1419F" -> "1419"; PetraStock appends single/double letter
// finish-variant suffixes like F/K/B to some profile numbers that don't
// exist as separate matWhItems rows). Confirmed live: 2,282 exact + 488
// suffix-stripped = 2,770 of 3,715 parsed color-variant rows (74.6%) resolve
// to a real matWhItems row this way. The remaining 344 rows don't match the
// `ALM<SUBCAT>-<COLORCODE>-<PROFILE>` pattern at all (e.g.
// "ALMPZ-MIX05/1-501", "ALMSCRR7001-00005" -- inconsistent old-system
// data-entry, no reliable pattern) and 945 parse fine but their profile
// number still isn't in matWhItems (not aluminum items this catalog ever
// carried) -- both categories are reported, not silently dropped, same
// policy as every prior import script this session.
//
// Same one-shot guard as every opening-balance path: an item+store pair
// that already has ANY real ledger activity (including from the ORIGINAL
// PetraStock/Alpha opening-balance imports) is skipped entirely, never
// added to or overwritten -- this run only fills in item+store pairs that
// still have zero ledger rows.
//
// READ-ONLY against PetraStock (SELECT only). Writes only ever land in
// matWhStockLedger via the same postLedgerMovement path every other
// opening-balance script uses. Pass DRY_RUN=1 to preview without writing.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { postLedgerMovement } from "../services/matWhLedger.js";

const ALUMINUM_STORE_CODES = ["301", "302", "303"];
const DRY_RUN = process.env.DRY_RUN === "1";

// ALM<SUBCAT>-<COLORCODE>-<PROFILE+optional letter suffix>
const CODE_RE = /^ALM([A-Z0-9]+)-([A-Z0-9/]+)-(.+)$/i;

const run = async () => {
    const erp = await getSqlPool("erp");

    const result = await erp.request().query(`
        SELECT itemno, store1, SUM(qty) AS qty
        FROM PetraStock
        WHERE store1 IN (${ALUMINUM_STORE_CODES.join(",")}) AND itemno LIKE 'ALM%'
        GROUP BY itemno, store1
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} ALM-prefixed item+store rows from PetraStock (stores ${ALUMINUM_STORE_CODES.join("/")}), old system untouched (SELECT only).`);

    const stores = await MatWhStore.findAll({ where: { storeCode: ALUMINUM_STORE_CODES } });
    const storeIdByCode = new Map(stores.map((s) => [s.storeCode, s.id]));

    const almItems = await MatWhItem.findAll({ where: { category: "ALM" }, attributes: ["id", "itemCode"] });
    const itemIdByUpperCode = new Map(almItems.map((i) => [i.itemCode.trim().toUpperCase(), i.id]));

    let unparsed = 0;
    let profileNoMatch = 0;
    const unparsedCodes = new Set();
    const profileNoMatchCodes = new Set();

    // Bucket by (itemId, storeId) -- sums every color-variant row for the
    // same profile+store into one pooled opening-balance candidate.
    const bucket = new Map(); // `${itemId}:${storeId}` -> qty
    const bucketMeta = new Map(); // same key -> { itemId, storeId }

    for (const row of rows) {
        const code = String(row.itemno || "").trim();
        const storeId = storeIdByCode.get(String(row.store1));
        if (!storeId) continue; // shouldn't happen, all 3 codes confirmed to exist

        const m = code.match(CODE_RE);
        if (!m) { unparsed++; unparsedCodes.add(code); continue; }

        const profileRaw = m[3].trim().toUpperCase();
        let itemId = itemIdByUpperCode.get(profileRaw);
        if (!itemId) {
            const stripped = profileRaw.replace(/[A-Z]+$/, "");
            if (stripped !== profileRaw) itemId = itemIdByUpperCode.get(stripped);
        }
        if (!itemId) { profileNoMatch++; profileNoMatchCodes.add(code); continue; }

        const key = `${itemId}:${storeId}`;
        bucket.set(key, (bucket.get(key) || 0) + Number(row.qty));
        bucketMeta.set(key, { itemId, storeId });
    }

    console.log(`Parsed OK: ${rows.length - unparsed}, unparsed (didn't match the expected pattern): ${unparsed}`);
    console.log(`Resolved to a real matWhItems row: ${bucket.size} distinct item+store pairs`);
    console.log(`Parsed but profile number not in matWhItems: ${profileNoMatch} rows (${profileNoMatchCodes.size} distinct codes)`);

    let created = 0;
    let skippedAlreadyHasActivity = 0;
    let skippedZeroOrNegativeQty = 0;

    for (const [key, qty] of bucket.entries()) {
        const { itemId, storeId } = bucketMeta.get(key);

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
    console.log(`Skipped -- item+store already has real ledger activity: ${skippedAlreadyHasActivity}`);
    console.log(`Skipped -- summed qty zero or negative: ${skippedZeroOrNegativeQty}`);
    console.log(`\nUnparsed codes (${unparsedCodes.size} distinct), first 30:`);
    console.log([...unparsedCodes].slice(0, 30).join(", "));
    console.log(`\nProfile-not-found codes (${profileNoMatchCodes.size} distinct), first 30:`);
    console.log([...profileNoMatchCodes].slice(0, 30).join(", "));
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Import failed:", err);
    process.exit(1);
});
