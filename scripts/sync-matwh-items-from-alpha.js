// ------------------------------------------------------
// backend/scripts/sync-matwh-items-from-alpha.js
// ------------------------------------------------------
// Re-syncs matWhItems from Alpha's InvItemsMF (Categ='ACC') instead of
// PetraStock -- discovered live 2026-09-15 that Alpha's real item master
// has 6,764 ACC items vs the 3,457 imported from PetraStock (a derived
// snapshot that apparently only reflects items with recent stock
// movement, not the full catalog) -- 3,311 real accessory items were
// missing entirely. Barcode is 100% populated in Alpha's full ACC set
// (vs the partial join-based backfill from the original PetraStock
// import); MinQty/MaxQty/ReOrderQty/prefvendor are confirmed still all
// zero across the complete 6,764-row set (not just our old subset), so
// they're not mapped -- there's nothing real there to bring over.
//
// UPDATES existing rows in place rather than delete-and-recreate (explicit
// direction, 2026-09-15): re-creating would give every item a new id, and
// this app already has real rows (5 PO-item, 4 ledger, 1 item-cost --
// found already orphaned/broken, pointing at a since-deleted test item)
// referencing matWhItems by id. Matched by itemCode; only category/
// subCategory/baseUnit/altUnit/conversionFactor/barcode/itemName/
// itemNameAr are refreshed from Alpha -- details/detailsAr/photoUrl/
// isActive are left alone (Alpha has no equivalent, and these are exactly
// the fields meant for hand-entry going forward). The 4 PetraStock-only
// items with no Alpha ACC counterpart at all (SCWSD4.2*25,
// WOOD-9016-1.3*2.8/3, RSH-9-707025, SCWMM-12C*8M -- confirmed live, not
// in Alpha under ANY category) are left untouched, not deleted.
//
// READ-ONLY against Alpha (SQL Server `erp` pool) -- one SELECT. All
// writes land only in this app's own matWhItems/matWhSubCategories/
// matWhUnits tables. Safe to re-run.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhSubCategory } from "../models/MatWhSubCategory.js";
import { MatWhUnit } from "../models/MatWhUnit.js";
import { MatWhCategory } from "../models/MatWhCategory.js";

// Case-variant codes that are really the same real-world value as one
// already seeded (verified live: Alpha's own data has both "ROL"/"rol"
// and "Piece"/"PIECE" for the same thing) -- reuse the existing one
// rather than create a near-duplicate lookup row.
const normalizeSubCategory = (code) => {
    if (!code) return null;
    const trimmed = code.trim();
    if (trimmed.toUpperCase() === "ROL") return "ROL";
    return trimmed;
};
const normalizeUnit = (code) => {
    if (!code) return null;
    const trimmed = code.trim();
    if (trimmed.toUpperCase() === "PIECE") return "Piece";
    return trimmed;
};

const run = async () => {
    const erp = await getSqlPool("erp");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await erp.request().query(`
        SELECT ItemNo, ItemDesc, ItemDesc_Ara, SubCateg, PUnit, IUnit, ConvRate, BarCode
        FROM InvItemsMF WHERE Categ = 'ACC'
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} ACC rows from Alpha, old system untouched (SELECT only).`);

    const [accCategory] = await MatWhCategory.findOrCreate({
        where: { categoryCode: "ACC" },
        defaults: { categoryCode: "ACC", categoryName: "ACC" },
    });

    const subCatsNeeded = new Set(rows.map((r) => normalizeSubCategory(r.SubCateg)).filter(Boolean));
    for (const code of subCatsNeeded) {
        await MatWhSubCategory.findOrCreate({
            where: { categoryId: accCategory.id, subCategoryCode: code },
            defaults: { categoryId: accCategory.id, subCategoryCode: code, subCategoryName: code },
        });
    }
    console.log(`✅ Sub-categories ensured: ${subCatsNeeded.size}`);

    const unitsNeeded = new Set();
    for (const r of rows) {
        if (r.PUnit) unitsNeeded.add(normalizeUnit(r.PUnit));
        if (r.IUnit) unitsNeeded.add(normalizeUnit(r.IUnit));
    }
    for (const code of unitsNeeded) {
        await MatWhUnit.findOrCreate({ where: { unitCode: code }, defaults: { unitCode: code, unitName: code } });
    }
    console.log(`✅ Units ensured: ${[...unitsNeeded].join(", ")}`);

    let updated = 0;
    let created = 0;
    let skipped = 0;

    for (const row of rows) {
        const itemCode = String(row.ItemNo || "").trim();
        if (!itemCode) { skipped++; continue; }

        const itemName = String(row.ItemDesc || "").trim() || String(row.ItemDesc_Ara || "").trim() || itemCode;
        const itemNameAr = String(row.ItemDesc_Ara || "").trim() || null;
        const category = "ACC";
        const subCategory = normalizeSubCategory(row.SubCateg);
        const baseUnit = normalizeUnit(row.PUnit) || "PCS";
        const altUnit = normalizeUnit(row.IUnit);
        const conversionFactor = row.ConvRate ?? null;
        const barcode = String(row.BarCode || "").trim() || null;

        try {
            const existing = await MatWhItem.findOne({ where: { itemCode } });
            if (existing) {
                await existing.update({ itemName, itemNameAr, category, subCategory, baseUnit, altUnit, conversionFactor, barcode });
                updated++;
            } else {
                await MatWhItem.create({ itemCode, itemName, itemNameAr, category, subCategory, baseUnit, altUnit, conversionFactor, barcode });
                created++;
            }
        } catch (err) {
            console.error(`⚠️ Skipped ${itemCode}:`, err.message);
            skipped++;
        }
    }

    console.log(`✅ Sync complete — updated: ${updated}, created: ${created}, skipped: ${skipped}`);
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Sync failed:", err);
    process.exit(1);
});
