// ------------------------------------------------------
// backend/scripts/create-matwh-item-variants-table.js
// ------------------------------------------------------
// Creates matWhItemVariants -- per direct design discussion, 2026-09-23:
// "every product...has a specific color, a specific length, and a unique
// barcode...a change in either color or length results in a new barcode."
//
// Deliberately NOT a redesign of matWhItems into one row per color+length
// (that shape was already tried and abandoned earlier this session as
// matWhProfileCatalog/MatWhProfileStock -- see the materials-warehouse-
// module memory's "profiles and items merged into ONE table" entry). This
// is additive instead: matWhItems stays one row per profile TYPE; this new
// table holds one row per real, physically-barcoded SKU (a specific
// color+length combination of that profile), mirroring how color already
// became a queryable ledger dimension in Phase 3 (see services/
// matWhLedger.js) rather than a catalog-row split. Only items that
// actually vary this way (category='ALM') are expected to have rows here
// -- plain accessories keep using matWhItems.barcode directly, unchanged.
//
// color follows the exact same convention as everywhere else in this
// module: NULL means mill-finish/raw (see matWhLedger.js's
// normalizeColor -- 'MILL' aliases to null at every boundary, this table
// included). lengthMm NULL means length isn't tracked for that variant.
//
// Idempotent (checks INFORMATION_SCHEMA.TABLES first), same pattern as
// every other create-matwh-*-table.js script this session.
import { sequelizeUtf8 } from "../config/db.js";

const tableExists = async (table) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table
    `, { replacements: { table } });
    return rows.length > 0;
};

const run = async () => {
    try {
        if (await tableExists("matWhItemVariants")) {
            console.log("- matWhItemVariants already exists, skipping");
        } else {
            await sequelizeUtf8.query(`
                CREATE TABLE \`matWhItemVariants\` (
                    \`id\` INT NOT NULL AUTO_INCREMENT,
                    \`itemId\` INT NOT NULL,
                    \`color\` VARCHAR(50) NULL,
                    \`lengthMm\` FLOAT NULL,
                    \`barcode\` VARCHAR(50) NOT NULL,
                    \`isActive\` TINYINT(1) NOT NULL DEFAULT 1,
                    \`createdAt\` DATETIME NOT NULL,
                    \`updatedAt\` DATETIME NOT NULL,
                    PRIMARY KEY (\`id\`),
                    -- MySQL treats NULL as distinct in a unique index, so
                    -- this doesn't strictly prevent two rows both at
                    -- (itemId, NULL color, same length) -- an accepted,
                    -- low-stakes gap (barcode itself stays globally unique
                    -- regardless, so no two variants can ever be confused
                    -- at lookup time even if this edge case occurs).
                    UNIQUE KEY \`matWhItemVariants_item_color_length\` (\`itemId\`, \`color\`, \`lengthMm\`),
                    UNIQUE KEY \`matWhItemVariants_barcode\` (\`barcode\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
            `);
            console.log("✅ Created matWhItemVariants");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create matWhItemVariants:", err);
        process.exit(1);
    }
};

run();
