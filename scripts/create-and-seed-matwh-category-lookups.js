// ------------------------------------------------------
// backend/scripts/create-and-seed-matwh-category-lookups.js
// ------------------------------------------------------
// Creates matWhCategories/matWhSubCategories/matWhUnits (models/
// MatWhCategory.js, MatWhSubCategory.js, MatWhUnit.js) and seeds them from
// the real distinct category/subCategory/unit values already present in
// matWhItems (imported from PetraStock -- see import-matwh-items-from-
// petrastock.js) rather than inventing a list. Only one real category
// exists in the imported data ("ACC"), with 28 real sub-categories under
// it and 8 real unit codes -- verified live 2026-09-15.
//
// Uses each model's own .sync() (create-if-missing, non-destructive), same
// as create-materials-warehouse-tables.js, then findOrCreate for seed rows
// -- safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";
import { QueryTypes } from "sequelize";
import { MatWhCategory } from "../models/MatWhCategory.js";
import { MatWhSubCategory } from "../models/MatWhSubCategory.js";
import { MatWhUnit } from "../models/MatWhUnit.js";

// name defaults to the code itself -- PetraStock only ever stored the
// short code (e.g. "SHUCO", "ROLL"), never a separate descriptive name, so
// there's no real name to import. Rename by hand later via Master Data.
const nameFromCode = (code) => code;

const run = async () => {
    await MatWhCategory.sync();
    await MatWhSubCategory.sync();
    await MatWhUnit.sync();
    console.log("✅ matWhCategories / matWhSubCategories / matWhUnits ready");

    const pairs = await sequelizeUtf8.query(
        `SELECT DISTINCT category, subCategory FROM matWhItems WHERE category IS NOT NULL ORDER BY category, subCategory`,
        { type: QueryTypes.SELECT },
    );

    const categoryIdByCode = new Map();
    for (const { category } of pairs) {
        if (!category || categoryIdByCode.has(category)) continue;
        const [row] = await MatWhCategory.findOrCreate({
            where: { categoryCode: category },
            defaults: { categoryCode: category, categoryName: nameFromCode(category) },
        });
        categoryIdByCode.set(category, row.id);
    }
    console.log(`✅ Categories ready: ${categoryIdByCode.size}`);

    let subCreated = 0;
    for (const { category, subCategory } of pairs) {
        if (!subCategory) continue;
        const categoryId = categoryIdByCode.get(category);
        const [, created] = await MatWhSubCategory.findOrCreate({
            where: { categoryId, subCategoryCode: subCategory },
            defaults: { categoryId, subCategoryCode: subCategory, subCategoryName: nameFromCode(subCategory) },
        });
        if (created) subCreated++;
    }
    console.log(`✅ Sub-categories created: ${subCreated}`);

    const unitRows = await sequelizeUtf8.query(
        `SELECT DISTINCT baseUnit AS unit FROM matWhItems WHERE baseUnit IS NOT NULL
         UNION SELECT DISTINCT altUnit AS unit FROM matWhItems WHERE altUnit IS NOT NULL`,
        { type: QueryTypes.SELECT },
    );
    let unitsCreated = 0;
    for (const { unit } of unitRows) {
        if (!unit) continue;
        const [, created] = await MatWhUnit.findOrCreate({
            where: { unitCode: unit },
            defaults: { unitCode: unit, unitName: nameFromCode(unit) },
        });
        if (created) unitsCreated++;
    }
    console.log(`✅ Units created: ${unitsCreated}`);

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed to create/seed category lookups:", err);
    process.exit(1);
});
