// ------------------------------------------------------
// backend/scripts/backfill-matwh-category-names-from-alpha.js
// ------------------------------------------------------
// Backfills real Arabic/English names for matWhCategories/
// matWhSubCategories from Alpha's own name lookup tables (InvCategCodes,
// Invt_SubCategInfo) -- discovered live 2026-09-15 in response to "check
// for other categories missing arabic names too". Unlike the profile ->
// Alpha-item matching problem (fuzzy, no shared key), this join is EXACT:
// our category/subCategory codes came from Alpha/PetraStock's own scheme
// in the first place, so joining by Categ/SubCateg code is 100% reliable,
// not a guess.
//
// READ-ONLY against Alpha (SQL Server `erp` pool) -- one SELECT each for
// categories and sub-categories, no writes there. All writes land only in
// this app's own matWhCategories/matWhSubCategories tables. Safe to
// re-run (only overwrites the placeholder code-as-name with the real
// name; never touches a name that's already been hand-edited to something
// different from its own code).
import { getSqlPool } from "../config/db.js";
import { MatWhCategory } from "../models/MatWhCategory.js";
import { MatWhSubCategory } from "../models/MatWhSubCategory.js";

const run = async () => {
    const erp = await getSqlPool("erp");

    const categories = await MatWhCategory.findAll();
    const alphaCats = await erp.request().query(`
        SELECT Categ, CategName, CategNameEng FROM InvCategCodes
        WHERE Categ IN (:codes)
    `.replace(':codes', categories.map((c) => `'${c.categoryCode}'`).join(','))
    );
    let catUpdated = 0;
    for (const cat of categories) {
        const alpha = alphaCats.recordset.find((a) => a.Categ === cat.categoryCode);
        if (!alpha) continue;
        // Only overwrite the placeholder (name === code, i.e. never
        // hand-edited) -- never clobber a real edit someone already made.
        const updates = {};
        if (cat.categoryName === cat.categoryCode && alpha.CategNameEng) updates.categoryName = alpha.CategNameEng;
        if (!cat.categoryNameAr && alpha.CategName) updates.categoryNameAr = alpha.CategName;
        if (Object.keys(updates).length) {
            await cat.update(updates);
            catUpdated++;
        }
    }
    console.log(`✅ Categories updated: ${catUpdated}/${categories.length}`);

    const subCategories = await MatWhSubCategory.findAll();
    const categoryCodeById = new Map(categories.map((c) => [c.id, c.categoryCode]));
    const alphaSubs = await erp.request().query(`SELECT Categ, SubCateg, SubCategName, SubCategNameEng FROM Invt_SubCategInfo`);

    let subUpdated = 0;
    for (const sub of subCategories) {
        const categCode = categoryCodeById.get(sub.categoryId);
        const alpha = alphaSubs.recordset.find((a) => a.Categ === categCode && a.SubCateg === sub.subCategoryCode);
        if (!alpha) continue;
        const updates = {};
        if (sub.subCategoryName === sub.subCategoryCode && alpha.SubCategNameEng) updates.subCategoryName = alpha.SubCategNameEng;
        if (!sub.subCategoryNameAr && alpha.SubCategName) updates.subCategoryNameAr = alpha.SubCategName;
        if (Object.keys(updates).length) {
            await sub.update(updates);
            subUpdated++;
        }
    }
    console.log(`✅ Sub-categories updated: ${subUpdated}/${subCategories.length}`);

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
