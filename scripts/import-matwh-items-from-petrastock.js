// ------------------------------------------------------
// backend/scripts/import-matwh-items-from-petrastock.js
// ------------------------------------------------------
// One-time copy of the accessories-cluster items from the OLD system
// (SQL Server `erp` pool: PetraStock, left-joined to InvItemsMF for
// barcode) into the NEW Materials Warehouse's own matWhItems table
// (MySQL). Per the decisions already confirmed for this module:
//   - store scope: accessories cluster only (200/201/202/203)
//   - legacy system: PetraStock is "the old one"
//   - item catalog: an owned MySQL copy, one-time import, no live sync
//
// READ-ONLY against the old system: this script issues exactly one SELECT
// against SQL Server (via getSqlPool('erp')) and never calls .query() with
// anything but SELECT there -- no INSERT/UPDATE/DELETE/MERGE touches
// PetraStock, InvItemsMF, or any other Alpha ERP table. Every write this
// script performs lands only in the new MySQL matWhItems table. Safe to
// re-run: matched by itemCode via findOrCreate, so a repeat run touches
// nothing that already exists (see "already present" count in the summary).
//
// Field mapping (verified live 2026-09-15 against real PetraStock rows):
//   itemCode    <- itemno (unique within the cluster, confirmed live)
//   itemName    <- itemdesceng, falling back to itemdescar then itemno for
//                  the 25 real rows in this cluster that have neither
//   itemNameAr  <- itemdescar
//   barcode     <- InvItemsMF.BarCode via itemno=ItemNo (matched for
//                  3082/3085 of the cluster; Alpha's own barcode
//                  convention is literally the item number, not a separate
//                  generated code)
//   category / subCategory <- categ / scateg
//   baseUnit / altUnit / conversionFactor <- unit1 / unit2 / conv
//   minQty/maxQty/reorderQty/details/detailsAr/photoUrl -- left NULL; none
//   of these exist in the old data, they're new fields on this catalog.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";

const ACCESSORIES_STORES = [200, 201, 202, 203];

const run = async () => {
    const erp = await getSqlPool("erp");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await erp.request().query(`
        SELECT p.itemno, p.itemdesceng, p.itemdescar, p.categ, p.scateg,
               p.unit1, p.unit2, p.conv, i.BarCode
        FROM PetraStock p
        LEFT JOIN InvItemsMF i ON i.ItemNo = p.itemno
        WHERE p.store IN (${ACCESSORIES_STORES.join(",")})
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} rows from PetraStock (accessories cluster), old system untouched (SELECT only).`);

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
