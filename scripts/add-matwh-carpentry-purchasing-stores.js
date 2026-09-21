// ------------------------------------------------------
// backend/scripts/add-matwh-carpentry-purchasing-stores.js
// ------------------------------------------------------
// Adds the 2 real Alpha stores (InvStoresMF) that seed-matwh-stores.js's
// original 14-row list missed -- confirmed live 2026-09-20 by comparing
// against Alpha's current InvStoresMF, which now has 16 rows, not 14.
// These same two store numbers (500, 9999) were already noted once before
// (seed-matwh-item-stores-from-alpha.js's own comment): real (StoreNo,
// ItemNo) pairs referencing them exist in Alpha's ledgers, but they were
// deliberately skipped rather than guessed at since no matching matWhStores
// row existed. Adding the real rows now closes that gap -- re-run
// seed-matwh-item-stores-from-alpha.js afterward to backfill the
// previously-skipped associations.
//
// storeType mirrors Alpha's own StoreType column exactly, same convention
// every other row here already follows: StoreType 4 -> 'reservation'
// (matches 199/299/399's own classification, even though 500's name reads
// as a real physical department rather than a virtual reservation bucket
// -- Alpha's own classification is not ours to second-guess). StoreType 2
// is a genuinely new value not seen in the original 14 rows (all were 1 or
// 4) -- mapped to a new 'purchasing' storeType string (storeType is a free
// string column, not a DB enum, so this needs no migration).
//
// Names are the real ones from Alpha's InvStoresMF (StoreName column,
// Arabic-only there) -- storeName below is a plain transliteration/
// description for the UI's LTR column, not a re-translation, same as every
// other row. Idempotent (findOrCreate on storeCode) -- safe to re-run.
import { MatWhStore } from "../models/MatWhStore.js";

const STORES = [
    { storeCode: "500", storeName: "Carpentry", storeNameAr: "مستودع المنجرة", storeType: "reservation" },
    { storeCode: "9999", storeName: "Purchasing", storeNameAr: "مستودع المشتريات", storeType: "purchasing" },
];

const run = async () => {
    for (const s of STORES) {
        const [row, created] = await MatWhStore.findOrCreate({
            where: { storeCode: s.storeCode },
            defaults: { ...s, isActive: true },
        });
        console.log(created ? `✅ Created ${s.storeCode} — ${s.storeName}` : `${s.storeCode} already exists`);
    }
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed to add stores:", err);
    process.exit(1);
});
