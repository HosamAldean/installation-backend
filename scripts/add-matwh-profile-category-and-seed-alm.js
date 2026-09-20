// ------------------------------------------------------
// backend/scripts/add-matwh-profile-category-and-seed-alm.js
// ------------------------------------------------------
// Adds category/subCategory to matWhProfileCatalog (models/
// MatWhProfileCatalog.js -- ALTER, table already exists), seeds the 'ALM'
// (aluminum) category + its 14 real sub-categories from Alpha's own
// InvItemsMF (Categ='ALM' -- SHUCO/PZ/NR/EA/KA/PR/SCR/RSH/EB/LUP/EC/PT/
// GR9/GR, verified live 2026-09-15), and sets every existing profile row's
// category to 'ALM' -- unambiguous, since Stock House's whole ItemProfile
// list IS the aluminum profile catalog. subCategory is deliberately left
// NULL per-row: Alpha tracks it per physical unit/barcode, not per profile
// type, and there's no reliable way to determine which of a profile's
// several possible sub-categories applies without an unreliable name
// guess -- the seeded list exists so it CAN be picked by hand, not so it
// gets auto-assigned.
//
// Idempotent: ALTER is column-existence-checked, category/sub-category
// seeding is findOrCreate, and the category backfill only touches rows
// that don't already have one set. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";
import { MatWhProfileCatalog } from "../models/MatWhProfileCatalog.js";
import { MatWhCategory } from "../models/MatWhCategory.js";
import { MatWhSubCategory } from "../models/MatWhSubCategory.js";

const ALM_SUBCATEGORIES = ["SHUCO", "PZ", "NR", "EA", "KA", "PR", "SCR", "RSH", "EB", "LUP", "EC", "PT", "GR9", "GR"];

const columnExists = async (table, column) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
};
const addColumnIfMissing = async (table, column, ddl) => {
    if (await columnExists(table, column)) {
        console.log(`- ${table}.${column} already exists, skipping`);
        return;
    }
    await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`✅ Added ${table}.${column}`);
};

const run = async () => {
    await addColumnIfMissing("matWhProfileCatalog", "category", "`category` VARCHAR(20) NULL");
    await addColumnIfMissing("matWhProfileCatalog", "subCategory", "`subCategory` VARCHAR(20) NULL");

    const [almCategory] = await MatWhCategory.findOrCreate({
        where: { categoryCode: "ALM" },
        defaults: { categoryCode: "ALM", categoryName: "ALM" },
    });
    console.log(`✅ Category ALM ready (id ${almCategory.id})`);

    let subCreated = 0;
    for (const code of ALM_SUBCATEGORIES) {
        const [, created] = await MatWhSubCategory.findOrCreate({
            where: { categoryId: almCategory.id, subCategoryCode: code },
            defaults: { categoryId: almCategory.id, subCategoryCode: code, subCategoryName: code },
        });
        if (created) subCreated++;
    }
    console.log(`✅ ALM sub-categories created: ${subCreated}/${ALM_SUBCATEGORIES.length}`);

    const [, affected] = await MatWhProfileCatalog.update(
        { category: "ALM" },
        { where: { category: null } },
    );
    console.log(`✅ Set category='ALM' on ${affected ?? "?"} profile rows`);

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
