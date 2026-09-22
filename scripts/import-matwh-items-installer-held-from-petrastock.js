// ------------------------------------------------------
// backend/scripts/import-matwh-items-installer-held-from-petrastock.js
// ------------------------------------------------------
// One-time copy of the installer-held items (PetraStock store=100 --
// "Installer — Al-Muqabalain / Firas / Mahmoud" per the old store map,
// 727 rows) into the NEW Materials Warehouse's own matWhItems table
// (MySQL). Direct sibling of import-matwh-items-from-petrastock.js (which
// covers store=200, the accessories cluster) -- kept as its own script
// rather than parameterizing that one, matching this codebase's existing
// one-script-per-scope import convention.
//
// READ-ONLY against the old system: exactly one SELECT against SQL Server
// (via getSqlPool('erp')), no INSERT/UPDATE/DELETE ever touches PetraStock
// or InvItemsMF. Every write lands only in the new MySQL matWhItems table.
// Safe to re-run: matched by itemCode via findOrCreate.
//
// Field mapping identical to the store=200 import (verified live
// 2026-09-15 against the real store=100 rows, 727 total):
//   itemCode <- itemno (1 real duplicate itemno found live -- findOrCreate
//               means the second occurrence just reports "already present",
//               not an error)
//   itemName <- itemdesceng, falling back to itemdescar then itemno (7
//               rows in this store have neither)
//   itemNameAr <- itemdescar
//   barcode <- InvItemsMF.BarCode via itemno=ItemNo (matched 724/727)
//   category / subCategory <- categ / scateg
//   baseUnit / altUnit / conversionFactor <- unit1 / unit2 / conv (unit1
//   always populated, confirmed live)
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";

const run = async () => {
    const erp = await getSqlPool("erp");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await erp.request().query(`
        SELECT p.itemno, p.itemdesceng, p.itemdescar, p.categ, p.scateg,
               p.unit1, p.unit2, p.conv, i.BarCode
        FROM PetraStock p
        LEFT JOIN InvItemsMF i ON i.ItemNo = p.itemno
        WHERE p.store = 100
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} rows from PetraStock (installer-held, store=100), old system untouched (SELECT only).`);

    let created = 0;
    let alreadyPresent = 0;
    let skipped = 0;

    for (const row of rows) {
        const itemCode = String(row.itemno || "").trim();
        if (!itemCode) { skipped++; continue; }

        const itemName =
            String(row.itemdesceng || "").trim() ||
            String(row.itemdescar || "").trim() ||
            itemCode;
        const itemNameAr = String(row.itemdescar || "").trim() || null;
        const baseUnit = String(row.unit1 || "").trim() || "PCS";
        const altUnit = String(row.unit2 || "").trim() || null;
        const barcode = String(row.BarCode || "").trim() || null;

        try {
            const [, wasCreated] = await MatWhItem.findOrCreate({
                where: { itemCode },
                defaults: {
                    itemCode, itemName, itemNameAr, baseUnit, altUnit,
                    conversionFactor: row.conv ?? null,
                    category: String(row.categ || "").trim() || null,
                    subCategory: String(row.scateg || "").trim() || null,
                    barcode,
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
