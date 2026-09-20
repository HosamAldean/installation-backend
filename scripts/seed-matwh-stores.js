// ------------------------------------------------------
// backend/scripts/seed-matwh-stores.js
// ------------------------------------------------------
// Seeds matWhStores with the full real store set from the old system's
// accessories + installer + aluminum clusters, per explicit direction to
// keep the store structure matching Alpha rather than consolidating into
// one store. Verified live 2026-09-15 against Alpha's own InvStoresMF
// (StoreNo/StoreName/StoreType) -- NOT just PetraStock's store/store1
// columns, which only show where accessory items currently sit and so
// under-counted this list on the first pass (missed 100/200, both real
// StoreType=1 stores in Alpha's own master despite holding 0 accessory
// items directly today, and 199/299, the StoreType=4 "reservation" stores
// for each department -- likely what this module's actual Reservations
// feature is meant to hold stock against). The aluminum cluster
// (300/301/302/303/399) was added in a second pass, same reasoning --
// Profile Store's per-unit stock (MatWhProfileStock.storeId) needs a real
// store to reference the same way item stock does.
//
// Names are the real ones from Alpha's InvStoresMF (StoreName column --
// Alpha has no separate English name, it's stored in Arabic only there,
// so storeName below is a plain transliteration for the UI's LTR column,
// not a re-translation). Idempotent (findOrCreate on storeCode) -- safe to
// re-run.
import { MatWhStore } from "../models/MatWhStore.js";

const STORES = [
    { storeCode: "100", storeName: "Installation - Al-Muqabalain", storeNameAr: "مستودع التركيب - المقابلين", storeType: "production" },
    { storeCode: "101", storeName: "Installation - Firas", storeNameAr: "مستودع التركيب - فراس", storeType: "production" },
    { storeCode: "102", storeName: "Installation - Mahmoud", storeNameAr: "مستودع التركيب - محمود", storeType: "production" },
    { storeCode: "199", storeName: "Installation - Reservation", storeNameAr: "مستودع الحجز - التركيب", storeType: "reservation" },
    { storeCode: "200", storeName: "Manufacturing - Accessories", storeNameAr: "مستودع التصنيع - اكسسوار", storeType: "production" },
    { storeCode: "201", storeName: "Accessories - Schuco", storeNameAr: "اكسسوار الشوكو", storeType: "production" },
    { storeCode: "202", storeName: "Accessories - Akeb", storeNameAr: "مستودع اكسسوار الاكيب", storeType: "production" },
    { storeCode: "203", storeName: "Accessories - Zippers", storeNameAr: "مستودع اكسسوار السحابات", storeType: "production" },
    { storeCode: "299", storeName: "Manufacturing - Reservation", storeNameAr: "مستودع حجز التصنيع", storeType: "reservation" },
    { storeCode: "300", storeName: "Aluminum", storeNameAr: "مستودع الالمنيوم", storeType: "production" },
    { storeCode: "301", storeName: "Aluminum - Schuco", storeNameAr: "مستودع الالمنيوم الشوكو", storeType: "production" },
    { storeCode: "302", storeName: "Aluminum - Akeb", storeNameAr: "مستودع الالمنيوم الاكيب", storeType: "production" },
    { storeCode: "303", storeName: "Aluminum - Zippers", storeNameAr: "مستودع الالمنيوم السحابات", storeType: "production" },
    { storeCode: "399", storeName: "Aluminum - Reservation", storeNameAr: "مستودع الحجز - الالمنيوم", storeType: "reservation" },
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
    console.error("❌ Failed to seed stores:", err);
    process.exit(1);
});
