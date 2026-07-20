// backend/utils/minStockSync.js
// Pushes finished units from Glass and Iron into the Main Stock warehouse
// system (STOCKO/Stock tables, MinStock SQL Server DB) so they become
// shippable through the existing MainStock.tsx / ShipMultipleItems.tsx
// screens — Min Stock is the single "store finished goods + ship out"
// control point across departments, per explicit direction: Glass and Iron
// do not get their own separate ship-out screens. Category (C) 2=Glass and
// 3=Steel/Wood already existed as legacy tags on mainStockCategories.ts
// before this file — Glass rows were previously only reaching Min Stock via
// staff manually re-entering them as a workaround (see glass.js's own
// header comment on the never-built ship-out step); this makes that flow
// automatic and correct instead of a manual duplicate-entry workaround.
import { getSqlPool } from "../config/db.js";

function pad(value, width) {
    const str = String(value ?? "").trim();
    if (str !== "" && /^\d+$/.test(str)) {
        return str.padStart(width, "0");
    }
    return str || "0".padStart(width, "0");
}

// Glass/Iron orders don't have a 1:1 STOCKO row of their own — items from
// the same project + production number + category land under one shared
// STOCKO header, exactly as if a Main Stock user had created it by hand.
async function findOrCreateStocko(pool, { projNo, projName, ProdctionNO, projMgr, category }) {
    const existing = await pool.request()
        .input("projNo", projNo)
        .input("ProdctionNO", ProdctionNO)
        .input("category", category)
        .query(`
            SELECT TOP 1 orderNo FROM STOCKO
            WHERE projNo = @projNo AND ProdctionNO = @ProdctionNO AND C = @category
            ORDER BY orderNo DESC
        `);
    if (existing.recordset[0]) return existing.recordset[0].orderNo;

    const inserted = await pool.request()
        .input("projName", projName || null)
        .input("projNo", projNo)
        .input("ProdctionNO", ProdctionNO)
        .input("projMgr", projMgr || null)
        .input("C", category)
        .query(`
            INSERT INTO STOCKO (projName, projNo, additional, ProdctionNO, projMgr, Worker, C, Date)
            OUTPUT INSERTED.orderNo
            VALUES (@projName, @projNo, NULL, @ProdctionNO, @projMgr, NULL, @C, GETDATE())
        `);
    return inserted.recordset[0].orderNo;
}

// Creates or updates one finished-unit row for a source item. `sourceKey`
// is a stable identifier back to the originating Glass/Iron item (e.g.
// "GLASS:322665:1" or "IRON:315076:1"), stamped into Stock.Note so a later
// re-sync (e.g. a Glass item's received qty increasing from a partial to a
// full receive) updates the same row instead of creating a duplicate —
// Stock has no dedicated column for this, and repurposing Note here is
// lower-risk than a schema change to a table other live systems also read.
// `qty` is always the source item's current TOTAL available quantity (not
// a delta), matching how Stock.QTY/SSTOCK.QTYIN both already work.
export async function pushFinishedUnitToMinStock({
    projNo, projName, ProdctionNO, projMgr, category, sourceKey, description, qty, unitNo, barcode: sourceBarcode,
}) {
    if (!projNo || !ProdctionNO || !qty || qty <= 0) return null;

    const pool = await getSqlPool("minstock");
    const minStockOrderNo = await findOrCreateStocko(pool, { projNo, projName, ProdctionNO, projMgr, category });

    const marker = `SRC:${sourceKey}`;
    const existing = await pool.request()
        .input("orderNo", minStockOrderNo)
        .input("marker", `${marker}%`)
        .query("SELECT serialNo FROM Stock WHERE orderNo = @orderNo AND Note LIKE @marker");

    if (existing.recordset[0]) {
        const serialNo = existing.recordset[0].serialNo;
        // [out] is the source of truth for shipped qty (same pattern as
        // mainStock.js's own checkout endpoints) — Stock.QTYOUT/SQTY are
        // kept in sync from it, not treated as authoritative here either.
        const shippedResult = await pool.request()
            .input("orderNo", minStockOrderNo)
            .input("serialNo", serialNo)
            .query("SELECT ISNULL(SUM(OUTQTY), 0) AS shipped FROM [out] WHERE orderNo = @orderNo AND serialNo = @serialNo");
        const shipped = shippedResult.recordset[0].shipped;
        await pool.request()
            .input("orderNo", minStockOrderNo)
            .input("serialNo", serialNo)
            .input("qty", qty)
            .input("shipped", shipped)
            .query(`
                UPDATE Stock
                SET QTY = @qty, QTYOUT = @shipped, SQTY = @qty - @shipped, X = CASE WHEN @qty = @shipped THEN 1 ELSE 0 END
                WHERE orderNo = @orderNo AND serialNo = @serialNo
            `);
        return { minStockOrderNo, serialNo, created: false };
    }

    const maxResult = await pool.request()
        .input("orderNo", minStockOrderNo)
        .query("SELECT ISNULL(MAX(serialNo), 0) AS maxSerial FROM Stock WHERE orderNo = @orderNo");
    const serialNo = maxResult.recordset[0].maxSerial + 1;
    // Reuse the source item's own barcode when given one (e.g. Glass's
    // already-printed physical sticker) so re-scanning that same sticker
    // resolves here via mainStock.js's own /barcode lookup — a freshly
    // generated number here would never match what's actually on the item.
    // Falls back to the same formula as mainStock.js's own item-creation
    // endpoint when the caller has no source barcode of its own to reuse.
    const barcode = sourceBarcode ?? parseInt(`${minStockOrderNo}${serialNo}`);
    const barcode1 = [pad(projNo, 5), pad(0, 2), pad(ProdctionNO, 3), pad(unitNo ?? serialNo, 6), pad(0, 6)].join(" ");

    await pool.request()
        .input("orderNo", minStockOrderNo)
        .input("serialNo", serialNo)
        .input("C", category)
        .input("Prodc", description || null)
        .input("UNO", String(unitNo ?? serialNo))
        .input("QTY", qty)
        .input("Note", marker)
        .input("barcode", barcode)
        .input("barcode1", barcode1)
        .query(`
            INSERT INTO Stock (orderNo, serialNo, C, Prodc, UNO, QTY, SQTY, QTYOUT, X, Date, Note, barcode, barcode1)
            VALUES (@orderNo, @serialNo, @C, @Prodc, @UNO, @QTY, @QTY, 0, 0, GETDATE(), @Note, @barcode, @barcode1)
        `);
    return { minStockOrderNo, serialNo, created: true };
}
