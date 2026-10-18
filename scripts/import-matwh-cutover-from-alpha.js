// ------------------------------------------------------
// backend/scripts/import-matwh-cutover-from-alpha.js
// ------------------------------------------------------
// Go-live cutover (2026-10-18, after the test data was wiped): rebuilds the
// non-aluminium item master from Alpha and posts each store's current
// Alpha balance as an opening balance, per direct decision -- Alpha as of
// today, stores 101/102/201/202/203 plus the non-aluminium lines held in
// 301/302/303.
//
// Aluminium bars (codes shaped ALM<family>-<colour>-<profile>, and any
// other Alpha Categ ALM line) are NOT loaded here: their colour token has
// to be translated to Petra's colour master first (one token matches
// several finishes), so they are only counted and listed in the report.
//
// Balance = SUM(Qty) over InvDailyDF + InvHistoryDF per store+item (Qty is
// already signed per voucher type; the two tables are disjoint -- see
// import-matwh-opening-balances-from-alpha-accessories.js). Unit cost is
// Alpha's InvItemsMF.ItemUnitCost; the opening balance goes through the
// same postLedgerMovement + applyReceiptCost path as POST
// /cutover/opening-balance, with the same guard (a store/item that already
// has ledger activity is skipped, never overwritten).
//
// READ-ONLY against Alpha (SELECTs only). DRY RUN BY DEFAULT: nothing is
// written unless APPLY=1. REPORT_JSON=<path> writes the full plan/result.
import fs from "fs";
import { getSqlPool, sequelizeUtf8 } from "../config/db.js";
import { MatWhItem } from "../models/MatWhItem.js";
import { MatWhStore } from "../models/MatWhStore.js";
import { MatWhCategory } from "../models/MatWhCategory.js";
import { MatWhSubCategory } from "../models/MatWhSubCategory.js";
import { MatWhUnit } from "../models/MatWhUnit.js";
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { postLedgerMovement, applyReceiptCost } from "../services/matWhLedger.js";

const APPLY = process.env.APPLY === "1";
const REPORT_JSON = process.env.REPORT_JSON || null;
const STORE_NOS = [101, 102, 201, 202, 203, 301, 302, 303];
const ALM_CODE = /^ALM[A-Z]*-[^-]+-.+/i;

// Same case-folding as sync-matwh-items-from-alpha.js.
const normalizeSubCategory = (code) => {
    if (!code) return null;
    const trimmed = code.trim();
    return trimmed.toUpperCase() === "ROL" ? "ROL" : trimmed || null;
};
const normalizeUnit = (code) => {
    if (!code) return null;
    const trimmed = code.trim();
    return trimmed.toUpperCase() === "PIECE" ? "Piece" : trimmed || null;
};
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

const run = async () => {
    const erp = await getSqlPool("erp");
    const db = process.env.MSSQL1_DB;

    // --- read Alpha (SELECT only) ---
    const balanceRows = (await erp.request().query(`
        SELECT b.StoreNo, b.ItemNo, SUM(b.Qty) AS qty FROM (
            SELECT StoreNo, ItemNo, Qty FROM ${db}.dbo.InvDailyDF WHERE StoreNo IN (${STORE_NOS.join(",")})
            UNION ALL
            SELECT StoreNo, ItemNo, Qty FROM ${db}.dbo.InvHistoryDF WHERE StoreNo IN (${STORE_NOS.join(",")})
        ) b GROUP BY b.StoreNo, b.ItemNo
    `)).recordset;
    const alphaItems = (await erp.request().query(`
        SELECT ItemNo, ItemDesc, ItemDesc_Ara, Categ, SubCateg, PUnit, IUnit, ConvRate, BarCode, ItemUnitCost
        FROM ${db}.dbo.InvItemsMF
    `)).recordset;
    const alphaByCode = new Map(alphaItems.map((r) => [String(r.ItemNo || "").trim().toUpperCase(), r]));

    const stores = await MatWhStore.findAll();
    const storeByNo = new Map(stores.map((s) => [String(s.storeCode), s]));

    // --- classify every store/item balance ---
    const plan = [];          // opening balances to post
    const aluminium = [];     // held back for the colour translation
    const problems = [];      // anything not loaded, with the reason
    const isAluminium = (code, categ) => ALM_CODE.test(code) || String(categ || "").toUpperCase() === "ALM";
    for (const r of balanceRows) {
        const code = String(r.ItemNo || "").trim();
        const qty = round3(r.qty);
        if (!code || qty === 0) continue;
        const a = alphaByCode.get(code.toUpperCase());
        const line = { storeNo: r.StoreNo, code, qty, categ: a?.Categ ?? null, name: a ? (String(a.ItemDesc_Ara || "").trim() || String(a.ItemDesc || "").trim()) : null };
        if (qty < 0) { problems.push({ ...line, reason: "negative balance in Alpha" }); continue; }
        if (isAluminium(code, a?.Categ)) { aluminium.push(line); continue; }
        if (!a) { problems.push({ ...line, reason: "code not in Alpha item master (InvItemsMF)" }); continue; }
        const store = storeByNo.get(String(r.StoreNo));
        if (!store) { problems.push({ ...line, reason: "store not set up in Materials Warehouse" }); continue; }
        const unitCost = a.ItemUnitCost != null && Number(a.ItemUnitCost) > 0 ? round3(a.ItemUnitCost) : null;
        plan.push({ ...line, storeId: store.id, unitCost, value: unitCost != null ? round3(unitCost * qty) : null });
    }

    // --- items: full Alpha ACC catalog + any other non-aluminium item with stock ---
    const neededCodes = new Set(alphaItems
        .filter((a) => String(a.Categ || "").toUpperCase() === "ACC")
        .map((a) => String(a.ItemNo || "").trim().toUpperCase()));
    for (const p of plan) neededCodes.add(p.code.toUpperCase());
    neededCodes.delete("");
    const existingItems = await MatWhItem.findAll({ attributes: ["id", "itemCode"] });
    const existingByCode = new Map(existingItems.map((i) => [i.itemCode.toUpperCase(), i]));
    const itemsToCreate = [];
    for (const key of neededCodes) {
        if (existingByCode.has(key)) continue;
        const a = alphaByCode.get(key);
        const code = String(a.ItemNo).trim();
        itemsToCreate.push({
            itemCode: code,
            itemName: String(a.ItemDesc || "").trim() || String(a.ItemDesc_Ara || "").trim() || code,
            itemNameAr: String(a.ItemDesc_Ara || "").trim() || null,
            category: String(a.Categ || "").trim().toUpperCase() || "ACC",
            subCategory: normalizeSubCategory(a.SubCateg),
            baseUnit: normalizeUnit(a.PUnit) || "PCS",
            altUnit: normalizeUnit(a.IUnit),
            conversionFactor: a.ConvRate ?? null,
            barcode: String(a.BarCode || "").trim() || null,
        });
    }
    // Barcodes are unique in matWhItems -- report clashes instead of failing.
    const barcodeCount = new Map();
    for (const i of itemsToCreate) if (i.barcode) barcodeCount.set(i.barcode.toUpperCase(), (barcodeCount.get(i.barcode.toUpperCase()) || 0) + 1);
    const dupBarcodes = new Set([...barcodeCount].filter(([, n]) => n > 1).map(([b]) => b));
    for (const i of itemsToCreate) {
        if (i.barcode && dupBarcodes.has(i.barcode.toUpperCase())) {
            problems.push({ storeNo: null, code: i.itemCode, qty: null, categ: i.category, name: i.itemName, reason: `barcode ${i.barcode} shared by several Alpha items -- item created without barcode` });
            i.barcode = null;
        }
    }

    const summary = {
        mode: APPLY ? "APPLY" : "DRY RUN",
        alphaBalanceLines: balanceRows.length,
        itemsExisting: existingItems.length,
        itemsToCreate: itemsToCreate.length,
        openingBalances: plan.length,
        openingQty: round3(plan.reduce((s, p) => s + p.qty, 0)),
        openingValue: round3(plan.reduce((s, p) => s + (p.value || 0), 0)),
        openingWithoutCost: plan.filter((p) => p.unitCost == null).length,
        aluminiumHeldBack: aluminium.length,
        problems: problems.length,
    };
    console.log(summary);

    const result = { created: 0, posted: 0, skippedExisting: 0, failed: [] };
    if (APPLY) {
        // Lookups first (categories / sub-categories / units).
        const cats = new Map();
        for (const code of new Set(itemsToCreate.map((i) => i.category))) {
            const [c] = await MatWhCategory.findOrCreate({ where: { categoryCode: code }, defaults: { categoryCode: code, categoryName: code } });
            cats.set(code, c);
        }
        for (const i of itemsToCreate) {
            if (!i.subCategory) continue;
            await MatWhSubCategory.findOrCreate({
                where: { categoryId: cats.get(i.category).id, subCategoryCode: i.subCategory },
                defaults: { categoryId: cats.get(i.category).id, subCategoryCode: i.subCategory, subCategoryName: i.subCategory },
            });
        }
        for (const u of new Set(itemsToCreate.flatMap((i) => [i.baseUnit, i.altUnit]).filter(Boolean))) {
            await MatWhUnit.findOrCreate({ where: { unitCode: u }, defaults: { unitCode: u, unitName: u } });
        }
        for (const i of itemsToCreate) {
            try {
                const row = await MatWhItem.create(i);
                existingByCode.set(row.itemCode.toUpperCase(), row);
                result.created++;
            } catch (err) {
                result.failed.push({ code: i.itemCode, step: "item", error: err.message });
            }
        }
        for (const p of plan) {
            const item = existingByCode.get(p.code.toUpperCase());
            if (!item) { result.failed.push({ code: p.code, step: "opening", error: "item missing" }); continue; }
            const t = await sequelizeUtf8.transaction();
            try {
                const existing = await MatWhStockLedger.count({ where: { storeId: p.storeId, itemId: item.id, color: null, lengthMm: null }, transaction: t });
                if (existing > 0) { await t.rollback(); result.skippedExisting++; continue; }
                await postLedgerMovement({
                    storeId: p.storeId, itemId: item.id, qty: p.qty, direction: "in", docType: "opening_balance",
                    refType: "cutover", refId: null, unitCost: p.unitCost ?? undefined, performedBy: null,
                    color: null, lengthMm: null,
                }, t);
                if (p.unitCost != null) await applyReceiptCost(item.id, p.storeId, p.qty, p.unitCost, t);
                await t.commit();
                result.posted++;
            } catch (err) {
                await t.rollback();
                result.failed.push({ code: p.code, store: p.storeNo, step: "opening", error: err.message });
            }
        }
        console.log(result);
    }

    if (REPORT_JSON) {
        fs.writeFileSync(REPORT_JSON, JSON.stringify({ summary, result, plan, itemsToCreate, aluminium, problems }, null, 1));
        console.log(`Report written to ${REPORT_JSON}`);
    }
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Cutover import failed:", err);
    process.exit(1);
});
