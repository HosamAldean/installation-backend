// ------------------------------------------------------
// backend/scripts/import-profiles-into-matwhitems.js
// ------------------------------------------------------
// Imports aluminum profiles directly into matWhItems (NOT
// matWhProfileCatalog) -- explicit direction, 2026-09-15: profiles and
// accessory items now live in ONE table. Consciously accepted tradeoff
// (confirmed by the user): the separate "Profile Store Operations"
// feature (aluminum barcode-scan stock/receipts/reservations) is built on
// MatWhProfileStock.profileCatalogId -> matWhProfileCatalog.id; with
// profiles no longer populating that table, that feature has nothing to
// attach stock to and is effectively unused going forward. This script
// does not touch matWhProfileCatalog at all -- it can be revived later by
// re-running import-matwh-profile-catalog-from-stockhouse.js if that
// feature is wanted again.
//
// Source: Stock House's guest.ItemProfile (1,973 rows, profileNo+
// profileName only -- see that script's own header for why there's
// nothing more to copy from there). itemCode <- ProfileNO (confirmed live:
// zero collisions with the existing ACC-category itemCodes already in
// matWhItems), itemName <- ProfileName, category fixed to 'ALM' (every
// profile here is aluminum). baseUnit defaults to 'PCS' (matWhItems.
// baseUnit is NOT NULL; Stock House's ItemProfile has no unit at all) --
// the follow-up enrichment pass (backfill-matwhitems-alm-from-alpha.js)
// overwrites this with a real unit wherever Alpha's data allows.
//
// READ-ONLY against Stock House (one SELECT). All writes land only in
// matWhItems. Idempotent (findOrCreate on itemCode) -- safe to re-run.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";

const run = async () => {
    const sh = await getSqlPool("stockhouse");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await sh.request().query(`SELECT ProfileNO, ProfileName, Details FROM guest.ItemProfile`);
    const rows = result.recordset;
    console.log(`Read ${rows.length} rows from guest.ItemProfile, old system untouched (SELECT only).`);

    let created = 0;
    let alreadyPresent = 0;
    let skipped = 0;

    for (const row of rows) {
        const itemCode = String(row.ProfileNO || "").trim();
        const itemName = String(row.ProfileName || "").trim();
        if (!itemCode || !itemName) { skipped++; continue; }

        try {
            const [, wasCreated] = await MatWhItem.findOrCreate({
                where: { itemCode },
                defaults: {
                    itemCode, itemName,
                    category: "ALM",
                    baseUnit: "PCS",
                    details: String(row.Details || "").trim() || null,
                },
            });
            if (wasCreated) created++; else alreadyPresent++;
        } catch (err) {
            console.error(`⚠️ Skipped ${itemCode}:`, err.message);
            skipped++;
        }
    }

    console.log(`✅ Import complete — created: ${created}, already present: ${alreadyPresent}, skipped: ${skipped}`);
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Import failed:", err);
    process.exit(1);
});
