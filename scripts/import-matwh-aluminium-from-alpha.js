// ------------------------------------------------------
// backend/scripts/import-matwh-aluminium-from-alpha.js
// ------------------------------------------------------
// Second half of the 2026-10-18 go-live cutover (see
// import-matwh-cutover-from-alpha.js): the aluminium lines that were held
// back. Same source -- Alpha's live balance (InvDailyDF + InvHistoryDF) --
// but each Alpha code is split into profile + colour so the stock lands on
// a real item variant (item + colour + 6300 mm, per direct decision), with
// the Alpha code itself as the variant barcode.
//
// Code readings (anything else is loaded as a plain item, exactly as Alpha
// holds it, with no colour -- e.g. Schueco S-codes):
//   A  ALM<fam>|ALRE|OTTO|OTTOS - <colour> - <profile>   ALMEA-7022P-8516
//   B  ALMSCRR<profile> - <colour>                        ALMSCRR9005-00005
//   C  <colour> - <profile>                               9005p-477490
//
// Colour: Alpha's short token (7022P, 00005...) does NOT map 1:1 to Petra's
// colour master (one token = several finishes), so the token -> mixCode
// translation comes from the user's filled-in sheet, passed as JSON
// (COLOUR_MAP_JSON={"7022P":"MX7022NT60",...}; "MILL" for raw). Lines whose
// token isn't translated are NOT loaded, only reported.
//
// Item: reused when a variant already carries this Alpha code as its
// barcode; otherwise one item per family + profile (itemCode
// "<family>-<profile>", e.g. ALMEA-8516), category ALM.
//
// READ-ONLY against Alpha. DRY RUN BY DEFAULT -- writes only with APPLY=1.
// REPORT_JSON=<path> writes the full plan.
import fs from "fs";
import { getSqlPool, sequelizeUtf8, sequelize2PetraErp } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhItemVariant } from "../models/MatWhItemVariant.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { postLedgerMovement, applyReceiptCost, normalizeColor } from "../services/matWhLedger.js";

const APPLY = process.env.APPLY === "1";
const REPORT_JSON = process.env.REPORT_JSON || null;
const COLOUR_MAP_JSON = process.env.COLOUR_MAP_JSON || null;
const STORE_NOS = [101, 102, 201, 202, 203, 301, 302, 303];
const LENGTH_MM = 6300;
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

// Same aluminium test as import-matwh-cutover-from-alpha.js -- exactly the
// lines that script held back.
const isAluminiumLine = (code, categ) => /^ALM[A-Z]*-[^-]+-.+/i.test(code) || String(categ || "").toUpperCase() === "ALM";

export function readCode(raw) {
    const code = raw.trim();
    let m = code.match(/^(ALM[A-Z]*|ALRE|OTTOS?)-([^-]+)-(.+)$/i);
    if (m) return { rule: "A", family: m[1].toUpperCase(), token: m[2].toUpperCase(), profile: m[3].toUpperCase() };
    m = code.match(/^ALMSCRR(\d+)-(.+)$/i);
    if (m) return { rule: "B", family: "ALMSCRR", token: m[2].toUpperCase(), profile: m[1].toUpperCase() };
    m = code.match(/^(\d{4}[A-Z]?)-(\d+)$/i);
    if (m) return { rule: "C", family: "ALM", token: m[1].toUpperCase(), profile: m[2].toUpperCase() };
    return { rule: "plain" };
}

const run = async () => {
    const colourMap = COLOUR_MAP_JSON ? JSON.parse(fs.readFileSync(COLOUR_MAP_JSON, "utf8")) : {};
    const tokenToColour = new Map(Object.entries(colourMap).map(([k, v]) => [k.trim().toUpperCase(), String(v).trim()]));
    const validColours = new Set((await sequelize2PetraErp.query(
        `SELECT TRIM(ci.mixCode) mixCode FROM colorInfo ci JOIN colorType ct ON ct.colorTypeId = ci.colorTypeId WHERE ct.colorTypeName = 'AL'`,
        { type: sequelize2PetraErp.QueryTypes.SELECT },
    )).map((c) => String(c.mixCode || "").toUpperCase()));
    validColours.add("MILL");

    const erp = await getSqlPool("erp");
    const db = process.env.MSSQL1_DB;
    const balanceRows = (await erp.request().query(`
        SELECT b.StoreNo, b.ItemNo, SUM(b.Qty) AS qty FROM (
            SELECT StoreNo, ItemNo, Qty FROM ${db}.dbo.InvDailyDF WHERE StoreNo IN (${STORE_NOS.join(",")})
            UNION ALL
            SELECT StoreNo, ItemNo, Qty FROM ${db}.dbo.InvHistoryDF WHERE StoreNo IN (${STORE_NOS.join(",")})
        ) b GROUP BY b.StoreNo, b.ItemNo
    `)).recordset;
    const alphaItems = (await erp.request().query(`
        SELECT ItemNo, ItemDesc, ItemDesc_Ara, Categ, PUnit, ItemUnitCost FROM ${db}.dbo.InvItemsMF
    `)).recordset;
    const alphaByCode = new Map(alphaItems.map((r) => [String(r.ItemNo || "").trim().toUpperCase(), r]));

    const stores = await MatWhStore.findAll();
    const storeByNo = new Map(stores.map((s) => [String(s.storeCode), s]));
    const variants = await MatWhItemVariant.findAll();
    const variantByBarcode = new Map(variants.filter((v) => v.barcode).map((v) => [v.barcode.toUpperCase(), v]));
    const items = await MatWhItem.findAll({ attributes: ["id", "itemCode", "barcode"] });
    const itemByCode = new Map(items.map((i) => [i.itemCode.toUpperCase(), i]));
    const itemBarcodes = new Set(items.filter((i) => i.barcode).map((i) => i.barcode.toUpperCase()));

    const lines = [];      // every aluminium balance line with its reading
    const held = [];       // not loaded, with reason
    for (const r of balanceRows) {
        const code = String(r.ItemNo || "").trim();
        const qty = round3(r.qty);
        if (!code || qty <= 0) continue;
        const a = alphaByCode.get(code.toUpperCase());
        if (!isAluminiumLine(code, a?.Categ)) continue;
        const store = storeByNo.get(String(r.StoreNo));
        const base = { storeNo: r.StoreNo, code, qty, name: a ? (String(a.ItemDesc_Ara || "").trim() || String(a.ItemDesc || "").trim()) : null,
            unitCost: a && Number(a.ItemUnitCost) > 0 ? round3(a.ItemUnitCost) : null, unit: a ? String(a.PUnit || "").trim() || null : null };
        if (!store) { held.push({ ...base, reason: "store not set up" }); continue; }
        const reading = readCode(code);
        if (reading.rule === "plain") {
            lines.push({ ...base, storeId: store.id, rule: "plain", itemCode: code, color: null, lengthMm: null });
            continue;
        }
        // A variant that already carries this Alpha code as its barcode is
        // authoritative for item, colour and length.
        const existing = variantByBarcode.get(code.toUpperCase());
        if (existing) {
            lines.push({ ...base, ...reading, storeId: store.id, colour: existing.color, color: existing.color, lengthMm: existing.lengthMm, existingItemId: existing.itemId, itemCode: null });
            continue;
        }
        const colour = tokenToColour.get(reading.token);
        if (!colour) { held.push({ ...base, ...reading, reason: `colour token ${reading.token} not translated yet` }); continue; }
        if (!validColours.has(colour.toUpperCase())) { held.push({ ...base, ...reading, reason: `colour ${colour} is not in Petra's colour list` }); continue; }
        lines.push({ ...base, ...reading, storeId: store.id, colour, color: colour, lengthMm: LENGTH_MM, existingItemId: null, itemCode: `${reading.family}-${reading.profile}` });
    }

    // Pools: store + item + colour + length (several Alpha codes can land on
    // the same pool, e.g. two tokens translated to one colour).
    const keyOfItem = (l) => (l.existingItemId ? `id:${l.existingItemId}` : `code:${l.itemCode.toUpperCase()}`);
    const pools = new Map();
    for (const l of lines) {
        const key = `${l.storeId}|${keyOfItem(l)}|${normalizeColor(l.color) ?? ""}|${l.lengthMm ?? ""}`;
        const p = pools.get(key) ?? { storeId: l.storeId, storeNo: l.storeNo, itemKey: keyOfItem(l), itemCode: l.itemCode, existingItemId: l.existingItemId, color: l.color, lengthMm: l.lengthMm, qty: 0, value: 0, costedQty: 0, codes: [], rule: l.rule, name: l.name, unit: l.unit };
        p.qty = round3(p.qty + l.qty);
        if (l.unitCost != null) { p.value += l.unitCost * l.qty; p.costedQty += l.qty; }
        p.codes.push(l.code);
        pools.set(key, p);
    }
    const poolList = [...pools.values()].map((p) => ({ ...p, unitCost: p.costedQty > 0 ? round3(p.value / p.costedQty) : null }));

    // Items and variants to create.
    const newItems = new Map();     // itemCode(upper) -> item fields
    const newVariants = new Map();  // itemKey|colour|length -> { itemKey, color, lengthMm, barcode }
    const barcodeNotes = [];
    for (const l of lines) {
        if (!l.existingItemId && !itemByCode.has(l.itemCode.toUpperCase()) && !newItems.has(l.itemCode.toUpperCase())) {
            newItems.set(l.itemCode.toUpperCase(), {
                itemCode: l.itemCode, itemName: l.name || l.itemCode, itemNameAr: l.name, category: "ALM",
                baseUnit: l.unit || "PCS", barcode: l.rule === "plain" && !itemBarcodes.has(l.code.toUpperCase()) ? l.code : null,
            });
        }
        if (l.rule === "plain" || l.existingItemId) continue;
        const vKey = `${keyOfItem(l)}|${l.color.toUpperCase()}|${l.lengthMm}`;
        const v = newVariants.get(vKey);
        if (!v) {
            const taken = variantByBarcode.has(l.code.toUpperCase());
            newVariants.set(vKey, { itemKey: keyOfItem(l), itemCode: l.itemCode, color: l.color, lengthMm: l.lengthMm, barcode: taken ? null : l.code });
            if (taken) barcodeNotes.push({ code: l.code, note: "barcode already used by another variant -- variant created without it" });
        } else {
            barcodeNotes.push({ code: l.code, note: `same item/colour/length as ${v.barcode ?? "another code"} -- stock merged, this code not stored as a barcode` });
        }
    }

    const summary = {
        mode: APPLY ? "APPLY" : "DRY RUN",
        aluminiumLines: lines.length + held.filter((h) => h.reason !== "store not set up").length,
        loadable: lines.length,
        loadableQty: round3(lines.reduce((s, l) => s + l.qty, 0)),
        held: held.length,
        heldQty: round3(held.reduce((s, h) => s + h.qty, 0)),
        pools: poolList.length,
        itemsToCreate: newItems.size,
        variantsToCreate: newVariants.size,
        coloursTranslated: tokenToColour.size,
    };
    console.log(summary);

    const result = { itemsCreated: 0, variantsCreated: 0, posted: 0, skippedExisting: 0, failed: [] };
    if (APPLY) {
        for (const it of newItems.values()) {
            try { const row = await MatWhItem.create(it); itemByCode.set(row.itemCode.toUpperCase(), row); result.itemsCreated++; }
            catch (err) { result.failed.push({ step: "item", code: it.itemCode, error: err.message }); }
        }
        const itemIdOf = (key) => (key.startsWith("id:") ? Number(key.slice(3)) : itemByCode.get(key.slice(5))?.id);
        for (const v of newVariants.values()) {
            const itemId = itemIdOf(v.itemKey);
            if (!itemId) { result.failed.push({ step: "variant", code: v.itemCode, error: "item missing" }); continue; }
            try {
                const exists = await MatWhItemVariant.findOne({ where: { itemId, color: v.color, lengthMm: v.lengthMm } });
                if (!exists) { await MatWhItemVariant.create({ itemId, color: v.color, lengthMm: v.lengthMm, barcode: v.barcode, isActive: true }); result.variantsCreated++; }
            } catch (err) { result.failed.push({ step: "variant", code: v.barcode ?? v.itemCode, error: err.message }); }
        }
        for (const p of poolList) {
            const itemId = itemIdOf(p.itemKey);
            if (!itemId) { result.failed.push({ step: "opening", code: p.codes.join(","), error: "item missing" }); continue; }
            const color = normalizeColor(p.color) ?? null;
            const t = await sequelizeUtf8.transaction();
            try {
                const existing = await MatWhStockLedger.count({ where: { storeId: p.storeId, itemId, color, lengthMm: p.lengthMm }, transaction: t });
                if (existing > 0) { await t.rollback(); result.skippedExisting++; continue; }
                await postLedgerMovement({
                    storeId: p.storeId, itemId, qty: p.qty, direction: "in", docType: "opening_balance",
                    refType: "cutover", refId: null, unitCost: p.unitCost ?? undefined, performedBy: null,
                    color, lengthMm: p.lengthMm,
                }, t);
                if (p.unitCost != null) await applyReceiptCost(itemId, p.storeId, p.qty, p.unitCost, t);
                await t.commit();
                result.posted++;
            } catch (err) {
                await t.rollback();
                result.failed.push({ step: "opening", code: p.codes.join(","), store: p.storeNo, error: err.message });
            }
        }
        console.log(result);
    }

    if (REPORT_JSON) {
        fs.writeFileSync(REPORT_JSON, JSON.stringify({ summary, result, pools: poolList, held, newItems: [...newItems.values()], newVariants: [...newVariants.values()], barcodeNotes }, null, 1));
        console.log(`Report written to ${REPORT_JSON}`);
    }
    process.exit(0);
};

if (process.argv[1] && process.argv[1].endsWith("import-matwh-aluminium-from-alpha.js")) {
    run().catch((err) => {
        console.error("❌ Aluminium import failed:", err);
        process.exit(1);
    });
}
