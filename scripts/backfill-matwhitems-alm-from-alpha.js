// ------------------------------------------------------
// backend/scripts/backfill-matwhitems-alm-from-alpha.js
// ------------------------------------------------------
// Same best-effort enrichment as the earlier backfill-matwh-profile-from-
// alpha-by-name.js, retargeted at matWhItems (category='ALM') now that
// profiles live there instead of matWhProfileCatalog. Matches itemName to
// Alpha's InvItemsMF (Categ='ALM') ItemDesc_Ara EXACTLY; only backfills
// when a name matches exactly ONE Alpha item (subCategory/baseUnit/
// altUnit/conversionFactor/minQty/barcode all come from that one match) --
// left blank when ambiguous (multiple candidates) or no match, same
// philosophy as before: never guess-attach a real barcode.
//
// READ-ONLY against Alpha (one SELECT, SQL Server `erp` pool). All writes
// land only in matWhItems/matWhUnits. Safe to re-run: only touches a row
// that doesn't already have a barcode.
import { getSqlPool } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhUnit } from "../models/MatWhUnit.js";
import { Op } from "sequelize";

const normalizeUnit = (code) => {
    if (!code) return null;
    const trimmed = code.trim();
    if (trimmed.toUpperCase() === "PIECE") return "Piece";
    return trimmed;
};

const run = async () => {
    const erp = await getSqlPool("erp");
    const almItems = await erp.request().query(`
        SELECT ItemDesc_Ara, BarCode, SubCateg, PUnit, IUnit, ConvRate, MinQty
        FROM InvItemsMF WHERE Categ = 'ALM'
    `);

    const byName = new Map();
    for (const row of almItems.recordset) {
        const key = (row.ItemDesc_Ara || "").trim();
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(row);
    }

    const unitsNeeded = new Set();
    for (const candidates of byName.values()) {
        if (candidates.length !== 1) continue;
        const [alpha] = candidates;
        if (alpha.PUnit) unitsNeeded.add(normalizeUnit(alpha.PUnit));
        if (alpha.IUnit) unitsNeeded.add(normalizeUnit(alpha.IUnit));
    }
    for (const unitCode of unitsNeeded) {
        await MatWhUnit.findOrCreate({ where: { unitCode }, defaults: { unitCode, unitName: unitCode } });
    }
    console.log(`✅ Units ensured: ${[...unitsNeeded].join(", ")}`);

    const profiles = await MatWhItem.findAll({ where: { category: "ALM" } });
    const usedBarcodes = new Set(
        (await MatWhItem.findAll({ where: { barcode: { [Op.ne]: null } }, attributes: ["barcode"], raw: true }))
            .map((r) => r.barcode),
    );

    let filled = 0;
    let ambiguous = 0;
    let noMatch = 0;
    let skippedBarcodeCollision = 0;

    for (const p of profiles) {
        if (p.barcode) continue; // already has one -- don't touch
        const key = (p.itemName || "").trim();
        const candidates = byName.get(key);
        if (!candidates) { noMatch++; continue; }
        if (candidates.length > 1) { ambiguous++; continue; }

        const [alpha] = candidates;
        const barcode = alpha.BarCode?.trim() || null;
        if (barcode && usedBarcodes.has(barcode)) { skippedBarcodeCollision++; continue; }

        await p.update({
            subCategory: alpha.SubCateg || null,
            baseUnit: normalizeUnit(alpha.PUnit) || p.baseUnit,
            altUnit: normalizeUnit(alpha.IUnit),
            conversionFactor: alpha.ConvRate || null,
            minQty: alpha.MinQty || null,
            barcode,
        });
        if (barcode) usedBarcodes.add(barcode);
        filled++;
    }

    console.log(`✅ Filled: ${filled}`);
    console.log(`⚠️ Ambiguous (left blank): ${ambiguous}`);
    console.log(`- No Alpha match: ${noMatch}`);
    if (skippedBarcodeCollision) console.log(`⚠️ Skipped for barcode collision: ${skippedBarcodeCollision}`);

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
