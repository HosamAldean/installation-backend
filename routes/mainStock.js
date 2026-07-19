// backend/routes/mainStock.js
// Read-only viewer for the "Main Stock" warehouse system (STOCKO/STOCK
// tables in the MinStock SQL Server database) — the same data previously
// only browsable through the separate MS Access/VB front-end. STOCKO is a
// production-order header (project, production number, worker, manager);
// STOCK holds the individual barcoded finished-product rows under each
// order, with QTY/QTYOUT/SQTY tracking what's shipped vs. remaining.
import express from "express";
import { getSqlPool, sequelize } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();
router.use(authenticateToken, authorizeRoles("shipping_manager", "admin"));

// Same latin1-passthrough workaround as followUp.js — only applies the
// re-decoded value if it actually looks like Arabic, so it can't corrupt
// text that was already correct.
const fixArabic = (str) => {
    if (!str || typeof str !== "string") return str;
    try {
        const buf = Buffer.from(str, "binary");
        const utf = buf.toString("utf8");
        return /[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي]/.test(utf) ? utf : str;
    } catch {
        return str;
    }
};

// GET /api/main-stock/projects/search?q=xxx
// Looks up real projects from the main MySQL project table (the same one
// used across installation tracking) so a warehouse order's project
// name/number can be auto-filled instead of retyped by hand. Also looks up
// the most recent project manager used for that project in this system's
// own order history (STOCKO, SQL Server) — the two databases can't be
// joined directly, so this is two queries merged in JS.
router.get("/projects/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        if (q.length < 2) return res.json({ success: true, projects: [] });

        const rows = await sequelize.query(
            `SELECT projectId, projectNo, projectName
             FROM project
             WHERE projectNo LIKE :q OR projectName LIKE :q
             ORDER BY projectNo DESC
             LIMIT 10`,
            { replacements: { q: `%${q}%` }, type: sequelize.QueryTypes.SELECT }
        );

        const projNos = rows.map(r => r.projectNo).filter(Boolean);
        const lastMgrByProjNo = new Map();
        if (projNos.length) {
            const pool = await getSqlPool("minstock");
            const request = pool.request();
            const projNoParams = projNos.map((_, i) => `@p${i}`).join(", ");
            projNos.forEach((p, i) => request.input(`p${i}`, p));
            const mgrResult = await request.query(`
                SELECT projNo, projMgr
                FROM (
                    SELECT projNo, projMgr,
                           ROW_NUMBER() OVER (PARTITION BY projNo ORDER BY orderNo DESC) AS rn
                    FROM STOCKO
                    WHERE projNo IN (${projNoParams}) AND projMgr IS NOT NULL AND projMgr <> ''
                ) ranked
                WHERE rn = 1
            `);
            mgrResult.recordset.forEach(r => lastMgrByProjNo.set(r.projNo, r.projMgr));
        }

        res.json({
            success: true,
            projects: rows.map(r => ({
                projectId: r.projectId,
                projectNo: r.projectNo,
                projectName: fixArabic(r.projectName),
                lastProjMgr: lastMgrByProjNo.get(r.projectNo) || null,
            })),
        });
    } catch (err) {
        console.error("❌ MAIN STOCK PROJECT SEARCH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to search projects" });
    }
});

// GET /api/main-stock/orders?search=&category=1&page=1&pageSize=25
// category: 1 = Aluminum, 3 = Steel/Wood, 2 = Glass (legacy, now handled by
// a separate system — barely used, but still selectable for completeness).
router.get("/orders", async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
        const offset = (page - 1) * pageSize;
        const search = String(req.query.search || "").trim();
        const category = [1, 2, 3].includes(parseInt(req.query.category)) ? parseInt(req.query.category) : null;

        const pool = await getSqlPool("minstock");

        const conditions = [];
        if (search) conditions.push("(projName LIKE @search OR projNo LIKE @search OR ProdctionNO LIKE @search)");
        if (category !== null) conditions.push("C = @category");
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const countRequest = pool.request();
        if (search) countRequest.input("search", `%${search}%`);
        if (category !== null) countRequest.input("category", category);
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM STOCKO ${whereClause}`);
        const total = countResult.recordset[0].total;

        const rowsRequest = pool.request();
        rowsRequest.input("offset", offset);
        rowsRequest.input("pageSize", pageSize);
        if (search) rowsRequest.input("search", `%${search}%`);
        if (category !== null) rowsRequest.input("category", category);
        const rowsResult = await rowsRequest.query(`
            SELECT orderNo, projName, projNo, additional, ProdctionNO, projMgr, Worker, Date, C
            FROM STOCKO
            ${whereClause}
            ORDER BY orderNo DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, orders: rowsResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ MAIN STOCK ORDERS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock orders" });
    }
});

// GET /api/main-stock/orders/:orderNo/items
router.get("/orders/:orderNo/items", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const pool = await getSqlPool("minstock");
        // Stock.QTYOUT/SQTY/X are confirmed unreliable in production data —
        // fully-shipped items (present in the permanent `out` log with
        // OUTQTY matching QTY) were found with QTYOUT still at 0. The real
        // shipped quantity is the sum of out.OUTQTY for that item, so
        // "shipped"/"remaining" here are derived from `out` directly
        // instead of trusting the denormalized Stock columns.
        const result = await pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT
                    s.orderNo, s.serialNo, s.C, s.Prodc, s.Type, s.UNO, s.SN, s.QTY, s.Date, s.Note,
                    s.barcode, s.barcode1, s.QTYOUT, s.SQTY, s.X,
                    ISNULL(o.shipped, 0) AS shipped,
                    s.QTY - ISNULL(o.shipped, 0) AS remaining
                FROM Stock s
                LEFT JOIN (
                    SELECT orderNo, serialNo, SUM(OUTQTY) AS shipped
                    FROM [out]
                    WHERE orderNo = @orderNo
                    GROUP BY orderNo, serialNo
                ) o ON o.orderNo = s.orderNo AND o.serialNo = s.serialNo
                WHERE s.orderNo = @orderNo
                ORDER BY s.serialNo ASC
            `);

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock items" });
    }
});

// GET /api/main-stock/projects/:projNo/production-numbers
// Distinct production numbers for a project, to populate the filter on the
// multi-item shipment page — matches the Access app's QALLD drill-down
// (all projects -> one project's production numbers -> items).
router.get("/projects/:projNo/production-numbers", async (req, res) => {
    try {
        const projNo = req.params.projNo;
        const pool = await getSqlPool("minstock");
        const result = await pool.request()
            .input("projNo", projNo)
            .query(`
                SELECT DISTINCT ProdctionNO
                FROM STOCKO
                WHERE projNo = @projNo
                ORDER BY ProdctionNO
            `);
        res.json({ success: true, productionNumbers: result.recordset.map(r => r.ProdctionNO) });
    } catch (err) {
        console.error("❌ MAIN STOCK PRODUCTION NUMBERS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch production numbers" });
    }
});

// GET /api/main-stock/projects/:projNo/items?productionNo=&onlyRemaining=true
// All Stock items across every order for a project (optionally narrowed to
// one production number) — the equivalent of the Access app's QALLD ->
// QSTOCK1 drill-down, needed so a single shipment can pull items from
// multiple orders under the same project/production run at once.
router.get("/projects/:projNo/items", async (req, res) => {
    try {
        const projNo = req.params.projNo;
        const productionNo = String(req.query.productionNo || "").trim();
        const onlyRemaining = req.query.onlyRemaining !== "false";

        const pool = await getSqlPool("minstock");
        const request = pool.request();
        request.input("projNo", projNo);
        const conditions = ["o.projNo = @projNo"];
        if (productionNo) {
            request.input("productionNo", productionNo);
            conditions.push("o.ProdctionNO = @productionNo");
        }

        const result = await request.query(`
            SELECT
                s.orderNo, s.serialNo, s.C, s.Prodc, s.UNO, s.QTY, s.Date, s.Note,
                s.barcode, s.barcode1,
                o.ProdctionNO, o.Worker, o.projName,
                ISNULL(shipped.total, 0) AS shipped,
                s.QTY - ISNULL(shipped.total, 0) AS remaining
            FROM Stock s
            JOIN STOCKO o ON o.orderNo = s.orderNo
            LEFT JOIN (
                SELECT orderNo, serialNo, SUM(OUTQTY) AS total
                FROM [out]
                GROUP BY orderNo, serialNo
            ) shipped ON shipped.orderNo = s.orderNo AND shipped.serialNo = s.serialNo
            WHERE ${conditions.join(" AND ")}
            ${onlyRemaining ? "AND (s.QTY - ISNULL(shipped.total, 0)) <> 0" : ""}
            ORDER BY o.orderNo DESC, s.serialNo ASC
        `);

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK PROJECT ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch project items" });
    }
});

// GET /api/main-stock/stock-summary?search=&onlyRemaining=true&category=
// Project-level rollup (total ordered / shipped / remaining) — the
// equivalent of the Access app's QALLR printable report. Unlike the
// original, which excludes already-fully-shipped Stock rows from the sums
// entirely (a quirk that under-counts a project's true total once any of
// its items finish shipping), this sums every item for the project first
// and only then optionally hides projects with nothing left to ship.
//
// Grouped by category (o.C) as well as project — previously this blended
// Aluminum/Glass/Steel-Wood into one row per project with no way to tell
// them apart, which became misleading once Glass/Iron auto-sync started
// mixing categories under the same project automatically (see
// backend/utils/minStockSync.js). A project with material in more than one
// category now surfaces as one row per category, and an optional
// ?category= filter narrows to a single one.
router.get("/stock-summary", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const onlyRemaining = req.query.onlyRemaining !== "false";
        const category = req.query.category !== undefined && req.query.category !== "" ? parseInt(req.query.category, 10) : null;

        const pool = await getSqlPool("minstock");
        const request = pool.request();
        const whereParts = [];
        if (search) {
            request.input("search", `%${search}%`);
            whereParts.push("(o.projName LIKE @search OR o.projNo LIKE @search)");
        }
        if (Number.isInteger(category)) {
            request.input("category", category);
            whereParts.push("o.C = @category");
        }
        const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

        const result = await request.query(`
            SELECT o.projNo, MAX(o.projName) AS projName, o.C AS category,
                   SUM(s.QTY) AS totalQty,
                   SUM(ISNULL(shipped.total, 0)) AS totalShipped,
                   SUM(s.QTY) - SUM(ISNULL(shipped.total, 0)) AS remaining
            FROM Stock s
            JOIN STOCKO o ON o.orderNo = s.orderNo
            LEFT JOIN (
                SELECT orderNo, serialNo, SUM(OUTQTY) AS total
                FROM [out]
                GROUP BY orderNo, serialNo
            ) shipped ON shipped.orderNo = s.orderNo AND shipped.serialNo = s.serialNo
            ${whereClause}
            GROUP BY o.projNo, o.C
            ${onlyRemaining ? "HAVING SUM(s.QTY) - SUM(ISNULL(shipped.total, 0)) <> 0" : ""}
            ORDER BY o.projNo DESC
        `);

        res.json({ success: true, projects: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK STOCK SUMMARY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock summary" });
    }
});

// GET /api/main-stock/shipments/projects?search=&category=
// Project-level shipment totals from the permanent `out` log — level 1 of
// the Access app's XOUT -> X1OUT -> OUT shipment-history drill-down.
//
// Grouped by category (s.C, from the STOCKO header the shipment's orderNo
// belongs to) as well as project, same reasoning as /stock-summary above —
// a project shipped in more than one category now surfaces as one row per
// category instead of a blended total.
router.get("/shipments/projects", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const category = req.query.category !== undefined && req.query.category !== "" ? parseInt(req.query.category, 10) : null;
        const pool = await getSqlPool("minstock");
        const request = pool.request();
        const whereParts = [];
        if (search) {
            request.input("search", `%${search}%`);
            whereParts.push("(s.projName LIKE @search OR o.projNo LIKE @search)");
        }
        if (Number.isInteger(category)) {
            request.input("category", category);
            whereParts.push("s.C = @category");
        }
        const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

        const result = await request.query(`
            SELECT o.projNo, MAX(s.projName) AS projName, s.C AS category, SUM(o.OUTQTY) AS totalShipped
            FROM [out] o
            LEFT JOIN STOCKO s ON s.orderNo = o.orderNo
            ${whereClause}
            GROUP BY o.projNo, s.C
            ORDER BY o.projNo DESC
        `);

        res.json({ success: true, projects: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK SHIPMENT PROJECTS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch shipment history" });
    }
});

// GET /api/main-stock/shipments/projects/:projNo/production-numbers?category=
// Level 2 of the drill-down — shipment totals per production number within
// a project. Optional ?category= (carried over from the level-1 row the
// user clicked) keeps the drill-down scoped to the same category rather
// than re-blending Aluminum/Glass/Steel-Wood back together one level down.
router.get("/shipments/projects/:projNo/production-numbers", async (req, res) => {
    try {
        const projNo = req.params.projNo;
        const category = req.query.category !== undefined && req.query.category !== "" ? parseInt(req.query.category, 10) : null;
        const pool = await getSqlPool("minstock");
        const request = pool.request().input("projNo", projNo);
        let categoryClause = "";
        if (Number.isInteger(category)) {
            request.input("category", category);
            categoryClause = "AND s.C = @category";
        }
        const result = await request.query(`
            SELECT o.ProdctionNO, SUM(o.OUTQTY) AS totalShipped
            FROM [out] o
            LEFT JOIN STOCKO s ON s.orderNo = o.orderNo
            WHERE o.projNo = @projNo ${categoryClause}
            GROUP BY o.ProdctionNO
            ORDER BY o.ProdctionNO
        `);
        res.json({ success: true, productionNumbers: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK SHIPMENT PRODUCTION NUMBERS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch production numbers" });
    }
});

// GET /api/main-stock/shipments/projects/:projNo/:productionNo/log?category=
// Level 3 of the drill-down — the individual shipment log entries (the
// Access app's OUT form), one row per item per shipment batch. Same
// category scoping as level 2.
router.get("/shipments/projects/:projNo/:productionNo/log", async (req, res) => {
    try {
        const { projNo, productionNo } = req.params;
        const category = req.query.category !== undefined && req.query.category !== "" ? parseInt(req.query.category, 10) : null;
        const pool = await getSqlPool("minstock");
        const request = pool.request().input("projNo", projNo).input("productionNo", productionNo);
        let categoryClause = "";
        if (Number.isInteger(category)) {
            request.input("category", category);
            categoryClause = "AND s.C = @category";
        }
        const result = await request.query(`
            SELECT o.A, o.orderNo, o.serialNo, o.Prodc, o.UNO, o.OUTQTY, o.Note, o.DATEO, o.BNO, o.FNO, o.DRIVER, o.barcode
            FROM [out] o
            LEFT JOIN STOCKO s ON s.orderNo = o.orderNo
            WHERE o.projNo = @projNo AND o.ProdctionNO = @productionNo ${categoryClause}
            ORDER BY o.DATEO DESC, o.A DESC
        `);
        res.json({ success: true, log: result.recordset });
    } catch (err) {
        console.error("❌ MAIN STOCK SHIPMENT LOG ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch shipment log" });
    }
});

// GET /api/main-stock/barcode/:barcode — look up a single Stock item by
// its scanned barcode, for the quick scan-to-find/ship workflow.
//
// Only the numeric `barcode` column (orderNo+serialNo, encoded in the
// Code128 symbol) is actually unique per item — `barcode1` (the readable
// string) only encodes project/production/unit, so two different items
// can share the exact same barcode1 (confirmed live: two different
// serialNos under the same order came back with an identical barcode1).
// Falling back to barcode1 and silently picking one match would risk
// showing/shipping the wrong physical item, so an ambiguous barcode1
// match is reported as an error instead of guessed at.
const itemSelectSql = `
    SELECT
        s.orderNo, s.serialNo, s.C, s.Prodc, s.UNO, s.QTY, s.Date, s.Note,
        s.barcode, s.barcode1,
        o.ProdctionNO, o.Worker, o.projName, o.projNo, o.projMgr,
        ISNULL(shipped.total, 0) AS shipped,
        s.QTY - ISNULL(shipped.total, 0) AS remaining
    FROM Stock s
    JOIN STOCKO o ON o.orderNo = s.orderNo
    LEFT JOIN (
        SELECT orderNo, serialNo, SUM(OUTQTY) AS total
        FROM [out]
        GROUP BY orderNo, serialNo
    ) shipped ON shipped.orderNo = s.orderNo AND shipped.serialNo = s.serialNo
`;

router.get("/barcode/:barcode", async (req, res) => {
    try {
        const raw = String(req.params.barcode || "").trim();
        if (!raw) {
            return res.status(400).json({ success: false, message: "Barcode is required" });
        }

        const pool = await getSqlPool("minstock");

        if (/^\d+$/.test(raw)) {
            const byBarcode = await pool.request()
                .input("barcode", parseInt(raw))
                .query(`${itemSelectSql} WHERE s.barcode = @barcode`);
            if (byBarcode.recordset[0]) {
                return res.json({ success: true, item: byBarcode.recordset[0] });
            }
        }

        const byBarcode1 = await pool.request()
            .input("barcode1", raw)
            .query(`${itemSelectSql} WHERE s.barcode1 = @barcode1`);

        if (byBarcode1.recordset.length === 0) {
            return res.status(404).json({ success: false, message: "No item found for this barcode" });
        }
        if (byBarcode1.recordset.length > 1) {
            return res.status(409).json({
                success: false,
                message: "Multiple items match this barcode — scan the numeric barcode instead of typing the readable code",
            });
        }

        res.json({ success: true, item: byBarcode1.recordset[0] });
    } catch (err) {
        console.error("❌ MAIN STOCK BARCODE LOOKUP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to look up barcode" });
    }
});

// POST /api/main-stock/checkout — ship items from one or more orders in a
// single shipment (same project, possibly different production runs/
// orders) — the general version of the per-order checkout below, needed
// for the multi-select shipment page mirroring the Access app's workflow
// of staging items from wherever you were browsing before confirming one
// shipment for all of them together.
router.post("/checkout", async (req, res) => {
    const { items, driver, formNo, batchNo, note } = req.body;
    if (!driver || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "driver and at least one item are required" });
    }

    let transaction;
    try {
        const pool = await getSqlPool("minstock");
        transaction = pool.transaction();
        await transaction.begin();

        // UPDLOCK+HOLDLOCK: without this, two concurrent shipments can both
        // read the same MAX(A) before either commits, handing out the same
        // batch id to two unrelated shipments. The lock is held until this
        // transaction commits/rolls back, serializing batch-id generation.
        const batchResult = await transaction.request().query("SELECT ISNULL(MAX(A), 0) AS maxA FROM [out] WITH (UPDLOCK, HOLDLOCK)");
        const batchId = batchResult.recordset[0].maxA + 1;

        const shipped = [];
        for (const { orderNo, serialNo, qty } of items) {
            const on = parseInt(orderNo);
            const sn = parseInt(serialNo);
            const shipQty = parseInt(qty);
            if (!Number.isInteger(on) || !Number.isInteger(sn) || !Number.isInteger(shipQty) || shipQty <= 0) {
                await transaction.rollback();
                return res.status(400).json({ success: false, message: `Invalid item: orderNo=${orderNo}, serialNo=${serialNo}, qty=${qty}` });
            }

            const orderResult = await transaction.request()
                .input("orderNo", on)
                .query("SELECT projNo, ProdctionNO FROM STOCKO WHERE orderNo = @orderNo");
            const order = orderResult.recordset[0];
            if (!order) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: `Order ${on} not found` });
            }

            const itemResult = await transaction.request()
                .input("orderNo", on)
                .input("serialNo", sn)
                .query(`
                    SELECT s.C, s.Prodc, s.UNO, s.barcode, s.QTY,
                           ISNULL((SELECT SUM(OUTQTY) FROM [out] WHERE orderNo = s.orderNo AND serialNo = s.serialNo), 0) AS alreadyShipped
                    FROM Stock s
                    WHERE s.orderNo = @orderNo AND s.serialNo = @serialNo
                `);
            const item = itemResult.recordset[0];
            if (!item) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: `Item serialNo ${sn} not found in order ${on}` });
            }
            const remaining = item.QTY - item.alreadyShipped;
            if (shipQty > remaining) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Cannot ship ${shipQty} for order ${on} / serialNo ${sn} — only ${remaining} remaining`,
                });
            }

            await transaction.request()
                .input("A", batchId)
                .input("orderNo", on)
                .input("serialNo", sn)
                .input("projNo", order.projNo)
                .input("ProdctionNO", order.ProdctionNO)
                .input("C", item.C)
                .input("Prodc", item.Prodc)
                .input("UNO", item.UNO)
                .input("OUTQTY", shipQty)
                .input("Note", note || null)
                .input("BNO", batchNo ? parseInt(batchNo) : null)
                .input("FNO", formNo ? parseInt(formNo) : null)
                .input("DRIVER", driver)
                .input("barcode", item.barcode)
                .query(`
                    INSERT INTO [out] (A, orderNo, serialNo, projNo, ProdctionNO, C, Prodc, UNO, OUTQTY, Note, DATEO, BNO, FNO, DRIVER, barcode)
                    VALUES (@A, @orderNo, @serialNo, @projNo, @ProdctionNO, @C, @Prodc, @UNO, @OUTQTY, @Note, GETDATE(), @BNO, @FNO, @DRIVER, @barcode)
                `);

            const newShipped = item.alreadyShipped + shipQty;
            await transaction.request()
                .input("orderNo", on)
                .input("serialNo", sn)
                .input("newShipped", newShipped)
                .query(`
                    UPDATE Stock
                    SET QTYOUT = @newShipped, SQTY = QTY - @newShipped, X = CASE WHEN QTY = @newShipped THEN 1 ELSE 0 END
                    WHERE orderNo = @orderNo AND serialNo = @serialNo
                `);

            shipped.push({ orderNo: on, serialNo: sn, shippedQty: shipQty, remaining: remaining - shipQty });
        }

        await transaction.commit();
        res.json({ success: true, batchId, shipped });
    } catch (err) {
        if (transaction) { try { await transaction.rollback(); } catch { /* already rolled back */ } }
        console.error("❌ MAIN STOCK MULTI CHECKOUT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to check out items" });
    }
});

// POST /api/main-stock/orders/:orderNo/checkout — ship one or more items
// out. Writes directly to the permanent `out` log (the same table already
// read elsewhere in this project for delivery reports/barcode lookups)
// rather than replicating the Access app's fragile staging-table dance
// (bump a shared counter -> unqualified cross join two staging tables,
// relying on exactly one header row existing at a time -> wipe the
// staging tables). Also keeps Stock.QTYOUT/SQTY/X correctly in sync going
// forward for anything still reading those columns directly, even though
// they're not the source of truth here.
router.post("/orders/:orderNo/checkout", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    const { items, driver, formNo, batchNo, note } = req.body;
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    if (!driver || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: "driver and at least one item are required" });
    }

    let transaction;
    try {
        const pool = await getSqlPool("minstock");
        transaction = pool.transaction();
        await transaction.begin();

        const orderResult = await transaction.request()
            .input("orderNo", orderNo)
            .query("SELECT projNo, ProdctionNO FROM STOCKO WHERE orderNo = @orderNo");
        const order = orderResult.recordset[0];
        if (!order) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Shared batch id for this whole checkout action — the equivalent
        // of the Access app's shared "A" counter, but computed safely
        // (MAX+1) instead of a global side-effecting UPDATE statement.
        // UPDLOCK+HOLDLOCK: without this, two concurrent shipments can both
        // read the same MAX(A) before either commits, handing out the same
        // batch id to two unrelated shipments. The lock is held until this
        // transaction commits/rolls back, serializing batch-id generation.
        const batchResult = await transaction.request().query("SELECT ISNULL(MAX(A), 0) AS maxA FROM [out] WITH (UPDLOCK, HOLDLOCK)");
        const batchId = batchResult.recordset[0].maxA + 1;

        const shipped = [];
        for (const { serialNo, qty } of items) {
            const sn = parseInt(serialNo);
            const shipQty = parseInt(qty);
            if (!Number.isInteger(sn) || !Number.isInteger(shipQty) || shipQty <= 0) {
                await transaction.rollback();
                return res.status(400).json({ success: false, message: `Invalid item: serialNo=${serialNo}, qty=${qty}` });
            }

            const itemResult = await transaction.request()
                .input("orderNo", orderNo)
                .input("serialNo", sn)
                .query(`
                    SELECT s.C, s.Prodc, s.UNO, s.barcode, s.QTY,
                           ISNULL((SELECT SUM(OUTQTY) FROM [out] WHERE orderNo = s.orderNo AND serialNo = s.serialNo), 0) AS alreadyShipped
                    FROM Stock s
                    WHERE s.orderNo = @orderNo AND s.serialNo = @serialNo
                `);
            const item = itemResult.recordset[0];
            if (!item) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: `Item serialNo ${sn} not found in this order` });
            }
            const remaining = item.QTY - item.alreadyShipped;
            if (shipQty > remaining) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Cannot ship ${shipQty} for serialNo ${sn} — only ${remaining} remaining`,
                });
            }

            await transaction.request()
                .input("A", batchId)
                .input("orderNo", orderNo)
                .input("serialNo", sn)
                .input("projNo", order.projNo)
                .input("ProdctionNO", order.ProdctionNO)
                .input("C", item.C)
                .input("Prodc", item.Prodc)
                .input("UNO", item.UNO)
                .input("OUTQTY", shipQty)
                .input("Note", note || null)
                .input("BNO", batchNo ? parseInt(batchNo) : null)
                .input("FNO", formNo ? parseInt(formNo) : null)
                .input("DRIVER", driver)
                .input("barcode", item.barcode)
                .query(`
                    INSERT INTO [out] (A, orderNo, serialNo, projNo, ProdctionNO, C, Prodc, UNO, OUTQTY, Note, DATEO, BNO, FNO, DRIVER, barcode)
                    VALUES (@A, @orderNo, @serialNo, @projNo, @ProdctionNO, @C, @Prodc, @UNO, @OUTQTY, @Note, GETDATE(), @BNO, @FNO, @DRIVER, @barcode)
                `);

            const newShipped = item.alreadyShipped + shipQty;
            await transaction.request()
                .input("orderNo", orderNo)
                .input("serialNo", sn)
                .input("newShipped", newShipped)
                .query(`
                    UPDATE Stock
                    SET QTYOUT = @newShipped, SQTY = QTY - @newShipped, X = CASE WHEN QTY = @newShipped THEN 1 ELSE 0 END
                    WHERE orderNo = @orderNo AND serialNo = @serialNo
                `);

            shipped.push({ serialNo: sn, shippedQty: shipQty, remaining: remaining - shipQty });
        }

        await transaction.commit();
        res.json({ success: true, batchId, shipped });
    } catch (err) {
        if (transaction) { try { await transaction.rollback(); } catch { /* already rolled back */ } }
        console.error("❌ MAIN STOCK CHECKOUT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to check out items" });
    }
});

// Matches the Access VBA's Format(Nz(value, 0), "000...") behavior used to
// build the readable barcode string — confirmed against live data that
// this zero-pads purely numeric values (e.g. projNo "4892" -> "04892") but
// passes non-numeric values through unchanged (e.g. projNo "26hr015" stays
// "26hr015", not truncated to "26" by a naive parseInt).
function pad(value, width) {
    const str = String(value ?? "").trim();
    if (str !== "" && /^\d+$/.test(str)) {
        return str.padStart(width, "0");
    }
    return str || "0".padStart(width, "0");
}

// POST /api/main-stock/orders — create a new production order (STOCKO)
router.post("/orders", async (req, res) => {
    const { projName, projNo, additional, ProdctionNO, projMgr, Worker, C } = req.body;
    if (!projNo || !ProdctionNO || ![1, 2, 3].includes(parseInt(C))) {
        return res.status(400).json({ success: false, message: "projNo, ProdctionNO, and a valid category (C) are required" });
    }

    let transaction;
    try {
        const pool = await getSqlPool("minstock");
        transaction = pool.transaction();
        await transaction.begin();

        // Reuse an existing STOCKO header for the same projNo+ProdctionNO+C
        // instead of always inserting a new one — matches the auto-sync
        // path's own findOrCreateStocko() behavior (minStockSync.js).
        // Without this, a worker manually creating an order for a
        // project/production/category that already has material logged
        // (whether from an earlier manual entry or an auto-synced Glass/
        // Iron item) would silently split that project's stock into two
        // separate headers.
        const existingResult = await transaction.request()
            .input("projNo", projNo)
            .input("ProdctionNO", ProdctionNO)
            .input("C", parseInt(C))
            .query(`
                SELECT TOP 1 orderNo FROM STOCKO
                WHERE projNo = @projNo AND ProdctionNO = @ProdctionNO AND C = @C
                ORDER BY orderNo DESC
            `);

        let orderNo;
        let existing = false;
        if (existingResult.recordset[0]) {
            orderNo = existingResult.recordset[0].orderNo;
            existing = true;
        } else {
            // orderNo is an identity column — let SQL Server generate it
            // rather than computing MAX()+1 ourselves (confirmed live:
            // manually supplying it fails with "Cannot insert explicit
            // value for identity column").
            const insertResult = await transaction.request()
                .input("projName", projName || null)
                .input("projNo", projNo)
                .input("additional", additional || null)
                .input("ProdctionNO", ProdctionNO)
                .input("projMgr", projMgr || null)
                .input("Worker", Worker || null)
                .input("C", parseInt(C))
                .query(`
                    INSERT INTO STOCKO (projName, projNo, additional, ProdctionNO, projMgr, Worker, C, Date)
                    OUTPUT INSERTED.orderNo
                    VALUES (@projName, @projNo, @additional, @ProdctionNO, @projMgr, @Worker, @C, GETDATE())
                `);
            orderNo = insertResult.recordset[0].orderNo;
        }

        await transaction.commit();
        res.json({ success: true, orderNo, existing });
    } catch (err) {
        if (transaction) { try { await transaction.rollback(); } catch { /* already rolled back */ } }
        console.error("❌ MAIN STOCK CREATE ORDER ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create stock order" });
    }
});

// POST /api/main-stock/orders/:orderNo/items — add a barcoded item to an
// order. Barcode formula confirmed against live data (rows with UNO filled
// in, generated by the Access app's GenerateBarcode/GenerateBarcode1):
//   barcode  = orderNo + serialNo, concatenated as digits
//   barcode1 = projNo(5) + additional(2) + ProdctionNO(3) + UNO(6) + SN(6), space-separated
// Rows without a UNO in the legacy data never got a real barcode at all
// (a data-quality gap in the old system) — every new item here always gets
// both, since UNO is required.
router.post("/orders/:orderNo/items", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    const { Prodc, UNO, QTY, Note } = req.body;
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    if (!Prodc || !UNO || !QTY || parseInt(QTY) <= 0) {
        return res.status(400).json({ success: false, message: "Prodc, UNO, and a positive QTY are required" });
    }

    let transaction;
    try {
        const pool = await getSqlPool("minstock");
        transaction = pool.transaction();
        await transaction.begin();

        const orderResult = await transaction.request()
            .input("orderNo", orderNo)
            .query("SELECT projNo, additional, ProdctionNO, C FROM STOCKO WHERE orderNo = @orderNo");
        const order = orderResult.recordset[0];
        if (!order) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const maxResult = await transaction.request()
            .input("orderNo", orderNo)
            .query("SELECT ISNULL(MAX(serialNo), 0) AS maxSerial FROM Stock WHERE orderNo = @orderNo");
        const serialNo = maxResult.recordset[0].maxSerial + 1;

        const barcode = parseInt(`${orderNo}${serialNo}`);
        const barcode1 = [
            pad(order.projNo, 5),
            pad(order.additional, 2),
            pad(order.ProdctionNO, 3),
            pad(UNO, 6),
            pad(0, 6), // SN — a separate legacy sub-serial field, not used here
        ].join(" ");

        await transaction.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("C", order.C)
            .input("Prodc", Prodc)
            .input("UNO", String(UNO))
            .input("QTY", parseInt(QTY))
            .input("Note", Note || null)
            .input("barcode", barcode)
            .input("barcode1", barcode1)
            .query(`
                INSERT INTO Stock (orderNo, serialNo, C, Prodc, UNO, QTY, SQTY, QTYOUT, X, Date, Note, barcode, barcode1)
                VALUES (@orderNo, @serialNo, @C, @Prodc, @UNO, @QTY, @QTY, 0, 0, GETDATE(), @Note, @barcode, @barcode1)
            `);

        await transaction.commit();
        res.json({ success: true, serialNo, barcode, barcode1 });
    } catch (err) {
        if (transaction) { try { await transaction.rollback(); } catch { /* already rolled back */ } }
        console.error("❌ MAIN STOCK CREATE ITEM ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create stock item" });
    }
});

export default router;
