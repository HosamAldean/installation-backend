// ------------------------------------------------------
// backend/scripts/fix-matwh-subcategory-uniqueness.js
// ------------------------------------------------------
// Fixes matWhSubCategories.subCategoryCode from a globally-unique column to
// a (categoryId, subCategoryCode) composite unique index -- discovered
// live 2026-09-15 while seeding the aluminum ('ALM') category: Alpha's own
// sub-category codes repeat across different parent categories (SHUCO/EA/
// EB/EC/KA/RSH/SCR are real sub-categories under BOTH accessories (ACC)
// and aluminum (ALM)). The original global-unique index would have made
// seeding ALM's "SHUCO" silently reuse ACC's existing "SHUCO" row instead
// of creating a separate ALM-scoped one.
//
// Idempotent: checks the index name before dropping/adding. Safe to
// re-run. Must run BEFORE add-matwh-profile-category-and-seed-alm.js.
import { sequelizeUtf8 } from "../config/db.js";

const indexExists = async (table, indexName) => {
    const [rows] = await sequelizeUtf8.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = :indexName`, {
        replacements: { indexName },
    });
    return rows.length > 0;
};

const run = async () => {
    if (await indexExists("matWhSubCategories", "subCategoryCode")) {
        await sequelizeUtf8.query("ALTER TABLE `matWhSubCategories` DROP INDEX `subCategoryCode`");
        console.log("✅ Dropped old global-unique index on subCategoryCode");
    } else {
        console.log("- Old index already gone, skipping drop");
    }

    if (await indexExists("matWhSubCategories", "matWhSubCategories_categoryId_subCategoryCode")) {
        console.log("- Composite index already exists, skipping add");
    } else {
        await sequelizeUtf8.query(
            "ALTER TABLE `matWhSubCategories` ADD UNIQUE INDEX `matWhSubCategories_categoryId_subCategoryCode` (`categoryId`, `subCategoryCode`)",
        );
        console.log("✅ Added composite unique index (categoryId, subCategoryCode)");
    }

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
