// ------------------------------------------------------
// backend/scripts/backfill-matwh-profile-from-alpha-by-name.js
// ------------------------------------------------------
// Best-effort backfill of subCategory/baseUnit/altUnit/conversionFactor/
// minQty/barcode for aluminum profiles (matWhProfileCatalog) from Alpha's
// InvItemsMF (Categ='ALM'), matched by exact profileName == ItemDesc_Ara.
// Per explicit direction (2026-09-15): only profiles with EXACTLY ONE
// matching Alpha item get backfilled; a profile whose name matches
// multiple Alpha items (the common case -- Alpha tracks per physical
// unit/cut-piece, many share a name) is left untouched and reported
// instead of guessing, since picking wrong would misattach a real
// barcode to the wrong physical profile.
//
// Dry-run analysis (2026-09-15, 1,973 profiles): 165 unique matches, 1,183
// ambiguous (multiple candidates), 625 no match at all -- most profiles
// simply can't be backfilled this way; this only helps the ~8% clean case.
//
// READ-ONLY against Alpha (one SELECT, SQL Server `erp` pool). All writes
// land only in this app's own matWhProfileCatalog/matWhUnits tables. Safe
// to re-run: only touches a profile row that doesn't already have a
// barcode (so a previous run, or a hand-entered value, is never
// overwritten).
import { getSqlPool } from "../config/db.js";
import { MatWhProfileCatalog } from "../models/MatWhProfileCatalog.js";
import { MatWhUnit } from "../models/MatWhUnit.js";

// Alpha's "PIECE" (all-caps) is the same real-world unit as the "Piece"
// already seeded from matWhItems (mixed-case) -- reuse it rather than
// create a case-varying near-duplicate lookup row.
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

    // Ensure whatever units we're about to introduce actually exist in the
    // lookup list, so the Master Data dropdown can show them properly.
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

    const profiles = await MatWhProfileCatalog.findAll();
    const usedBarcodes = new Set(
        profiles.filter((p) => p.barcode).map((p) => p.barcode),
    );

    let filled = 0;
    let ambiguous = 0;
    let noMatch = 0;
    let skippedBarcodeCollision = 0;
    const ambiguousList = [];

    for (const p of profiles) {
        if (p.barcode) continue; // already has one (hand-entered or a prior run) -- don't touch
        const key = (p.profileName || "").trim();
        const candidates = byName.get(key);
        if (!candidates) { noMatch++; continue; }
        if (candidates.length > 1) {
            ambiguous++;
            ambiguousList.push({ profileNo: p.profileNo, profileName: p.profileName, candidateCount: candidates.length });
            continue;
        }
        const [alpha] = candidates;
        const barcode = alpha.BarCode?.trim() || null;
        if (barcode && usedBarcodes.has(barcode)) {
            // Two different profiles' names both uniquely matched to the
            // same Alpha barcode string -- shouldn't happen (BarCode is
            // Alpha's own unique key) but guarded anyway.
            skippedBarcodeCollision++;
            continue;
        }
        await p.update({
            subCategory: alpha.SubCateg || null,
            baseUnit: normalizeUnit(alpha.PUnit),
            altUnit: normalizeUnit(alpha.IUnit),
            conversionFactor: alpha.ConvRate || null,
            minQty: alpha.MinQty || null,
            barcode,
        });
        if (barcode) usedBarcodes.add(barcode);
        filled++;
    }

    console.log(`✅ Filled: ${filled}`);
    console.log(`⚠️ Ambiguous (left blank, multiple Alpha candidates): ${ambiguous}`);
    console.log(`- No Alpha match at all: ${noMatch}`);
    if (skippedBarcodeCollision) console.log(`⚠️ Skipped for barcode collision: ${skippedBarcodeCollision}`);
    console.log("\nSample of ambiguous profiles (first 20):");
    console.log(JSON.stringify(ambiguousList.slice(0, 20), null, 2));

    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
});
