// ------------------------------------------------------
// backend/scripts/seed-matwh-item-stores-from-alpha.js
// ------------------------------------------------------
// Creates matWhItemStores (.sync(), create-if-missing) and seeds it from
// Alpha's own real movement history -- InvDailyDF (recent, ~121K rows) and
// InvHistoryDF (archived, ~474K rows) both carry (StoreNo, ItemNo) pairs
// for every real stock movement. Combining both and matching case-
// insensitively against matWhItems.itemCode (Alpha data has known casing
// inconsistencies, e.g. "rol"/"ROL" seen earlier this project) gave, when
// checked live: 6,719 of our 8,725 items with real store evidence, 1,562
// of those in more than one store, 2,006 with no evidence at all --
// deliberately left unassigned (never guessed), which the reservation
// flow treats as "any store selectable" rather than blocked.
//
// storeCode on matWhStores is the same StoreNo Alpha uses (matWhStores was
// itself seeded from Alpha's InvStoresMF, see seed-matwh-stores.js) -- no
// translation needed between the two.
//
// READ-ONLY against Alpha (two SELECTs). All writes land only in
// matWhItemStores. Idempotent (findOrCreate per itemId+storeId pair) --
// safe to re-run; re-running picks up any newer Alpha movement history
// without duplicating existing associations.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhItemStore } from "../models/MatWhItemStore.js";

const run = async () => {
    await MatWhItemStore.sync();
    console.log("✅ matWhItemStores ready");

    const erp = await getSqlPool("erp");
    const [daily, history] = await Promise.all([
        erp.request().query("SELECT DISTINCT StoreNo, ItemNo FROM InvDailyDF"),
        erp.request().query("SELECT DISTINCT StoreNo, ItemNo FROM InvHistoryDF"),
    ]);
    console.log(`Read ${daily.recordset.length} + ${history.recordset.length} rows from Alpha, old system untouched (SELECT only).`);

    const alphaByItem = new Map(); // itemCode (upper) -> Set<StoreNo>
    for (const r of [...daily.recordset, ...history.recordset]) {
        const code = String(r.ItemNo || "").trim().toUpperCase();
        if (!code) continue;
        if (!alphaByItem.has(code)) alphaByItem.set(code, new Set());
        alphaByItem.get(code).add(r.StoreNo);
    }

    const stores = await MatWhStore.findAll();
    const storeIdByCode = new Map(stores.map((s) => [String(s.storeCode).trim(), s.id]));

    const items = await MatWhItem.findAll({ attributes: ["id", "itemCode"] });

    let created = 0;
    let alreadyPresent = 0;
    let itemsWithAnyStore = 0;
    let noEvidence = 0;
    let unknownStoreCode = 0;

    for (const item of items) {
        const alphaStores = alphaByItem.get(item.itemCode.trim().toUpperCase());
        if (!alphaStores || alphaStores.size === 0) {
            noEvidence++;
            continue;
        }
        itemsWithAnyStore++;
        for (const storeNo of alphaStores) {
            const storeId = storeIdByCode.get(String(storeNo).trim());
            if (!storeId) { unknownStoreCode++; continue; }
            const [, wasCreated] = await MatWhItemStore.findOrCreate({
                where: { itemId: item.id, storeId },
            });
            if (wasCreated) created++; else alreadyPresent++;
        }
    }

    console.log(`✅ Seed complete — items with store evidence: ${itemsWithAnyStore}, no evidence (left unassigned): ${noEvidence}`);
    console.log(`✅ Associations — created: ${created}, already present: ${alreadyPresent}`);
    if (unknownStoreCode) console.log(`⚠️ Alpha store numbers with no matching matWhStores row: ${unknownStoreCode}`);
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
