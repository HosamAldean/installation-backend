// backend/routes/projOrders.js
// Production/manufacturing order intake for the "Proj" SQL Server database
// (dbo.orders / dbo.orderdetails) — previously only creatable through the
// legacy MS Access front-end ("Proj - 2024-V2.1.mdb"), still live and
// actively used (confirmed: newest row at time of writing was created
// minutes before this file was). This table is NOT the same thing as
// IIT_Petra.orders (MySQL) — that's a separate, unrelated order-management
// system with its own GM-approval workflow that instOrders.js/
// installationRequests.js already read from; nothing in this codebase
// writes to it, and this file doesn't touch it either. This is specifically
// the production-order concept the legacy Access "orders" form owned:
// projNo/projName/projMgr/Color/ProdctionNO/ProdctionDate, which
// stockHouse.js's resolveProductionOrder() and Process/cutting tracking
// downstream in the Access app both key off of.
//
// Schema confirmed live (not assumed): dbo.orders.orderNo is a SQL Server
// IDENTITY column (seed 220000, increment 1) — same pattern as Glass's
// Sorders.orderNo (see glass.js) — so it's never supplied by the caller,
// always OUTPUT INSERTED. dbo.orderdetails.barcode is an int, generated
// client-side by the legacy app; its real format was confirmed against live
// rows (not the same formula as glass.js's buildBarcode — that one
// zero-pads serialNo to 4 digits, this one doesn't): 2-digit year + last 4
// digits of orderNo + serialNo, concatenated with no padding, e.g.
// orderNo 322633 serialNo 33 -> barcode 26263333.
import express from "express";
import { getSqlPool, withSqlRetry } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { User } from "../models/User.js";

const router = express.Router();

// Production order intake sits upstream of installation tracking, which is
// already gated to installation_manager/admin (see installationRequests.js,
// instOrders.js) — mirrored here since there's no more specific "production
// intake" role in the current taxonomy. Revisit if that turns out wrong.
router.use(authenticateToken, authorizeRoles("installation_manager", "admin"));

function buildBarcode(orderNo, serialNo) {
    const yy = String(new Date().getFullYear()).slice(-2);
    const last4 = String(orderNo).slice(-4);
    return parseInt(`${yy}${last4}${serialNo}`, 10);
}

async function resolveUsername(req) {
    const user = await User.findByPk(req.user.userId, { attributes: ["username"] });
    return user?.username || String(req.user.userId);
}

// GET /api/proj-orders?search=&page=&pageSize= — order list with per-order
// line counts, mirroring glass.js's GET /orders.
router.get("/", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const whereClause = search ? "WHERE o.projNo LIKE @search OR o.projName LIKE @search" : "";

        const { total, rows } = await withSqlRetry("proj", async (pool) => {
            const countRequest = pool.request();
            if (search) countRequest.input("search", `%${search}%`);
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.orders o ${whereClause}`);

            const rowsRequest = pool.request();
            rowsRequest.input("offset", offset).input("pageSize", pageSize);
            if (search) rowsRequest.input("search", `%${search}%`);
            const rowsResult = await rowsRequest.query(`
                SELECT
                    o.orderNo, o.projNo, o.projName, o.projMgr, o.oderDate, o.Color,
                    o.ProdctionNO, o.ProdctionDate, o.dateFinsh,
                    ISNULL(lines.lineCount, 0) AS lineCount
                FROM dbo.orders o
                LEFT JOIN (
                    SELECT orderNo, COUNT(*) AS lineCount
                    FROM dbo.orderdetails
                    GROUP BY orderNo
                ) lines ON lines.orderNo = o.orderNo
                ${whereClause}
                ORDER BY o.orderNo DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            return { total: countResult.recordset[0].total, rows: rowsResult.recordset };
        });

        res.json({ success: true, orders: rows, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROJ ORDERS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch orders" });
    }
});

// POST /api/proj-orders — create a new order header (dbo.orders). orderNo
// is a SQL Server IDENTITY column — never supplied by the caller.
router.post("/", async (req, res) => {
    const { projNo, projName, projMgr, Color, ProdctionNO, ProdctionDate } = req.body;
    if (!projNo || !String(projNo).trim()) {
        return res.status(400).json({ success: false, message: "projNo is required" });
    }

    try {
        const pool = await getSqlPool("proj");
        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("projNo", String(projNo).trim())
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .input("Color", Color || null)
            .input("ProdctionNO", ProdctionNO || null)
            .input("ProdctionDate", ProdctionDate || null)
            .input("sUser", sUser)
            .query(`
                INSERT INTO dbo.orders
                    (projNo, projName, projMgr, oderDate, Color, ProdctionNO, ProdctionDate, SUser, SDate)
                OUTPUT INSERTED.orderNo
                VALUES
                    (@projNo, @projName, @projMgr, GETDATE(), @Color, @ProdctionNO, @ProdctionDate, @sUser, GETDATE())
            `);
        res.status(201).json({ success: true, orderNo: result.recordset[0].orderNo });
    } catch (err) {
        console.error("❌ PROJ ORDER CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create order" });
    }
});

// PUT /api/proj-orders/:orderNo — edit projName/projMgr only. projNo and
// ProdctionNO are excluded: stockHouse.js's resolveProductionOrder and this
// file's own resolveOrderByProduction/department-log lookups join on them,
// so changing either after material has been reserved/checked against the
// old value would silently break that cross-database link. Color and
// ProdctionDate are excluded too, per the extra caution warranted here —
// dbo.orders/dbo.orderdetails are still actively written day-to-day by a
// live legacy MS Access app with no optimistic-concurrency column, so any
// edit here is a plain last-write-wins UPDATE against that app's own
// concurrent edits, same risk profile the Access app's own multi-user
// editing already has.
router.put("/:orderNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { projName, projMgr } = req.body;

    try {
        const result = await withSqlRetry("proj", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .query(`
                UPDATE dbo.orders
                SET projName = @projName, projMgr = @projMgr
                WHERE orderNo = @orderNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROJ ORDER UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order" });
    }
});

// GET /api/proj-orders/:orderNo/items — orderdetails lines for an order.
router.get("/:orderNo/items", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo, 10);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const pool = await getSqlPool("proj");
        const result = await pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT orderNo, serialNo, Prudact, [1] AS field1, [2] AS field2, itemNo, note, barcode
                FROM dbo.orderdetails
                WHERE orderNo = @orderNo
                ORDER BY serialNo ASC
            `);

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ PROJ ORDER ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order items" });
    }
});

// POST /api/proj-orders/:orderNo/items — add an order line (dbo.orderdetails).
// [1]/[2] are the legacy Access form's own unlabeled free-text columns
// (confirmed live: used inconsistently for dimensions, notes, or item
// descriptions depending on department — not a fixed schema, so accepted
// here as opaque optional text rather than parsed/validated).
router.post("/:orderNo/items", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { Prudact, field1, field2, itemNo, note } = req.body;

    let transaction;
    try {
        const pool = await getSqlPool("proj");
        transaction = pool.transaction();
        await transaction.begin();

        const orderResult = await transaction.request()
            .input("orderNo", orderNo)
            .query("SELECT orderNo FROM dbo.orders WHERE orderNo = @orderNo");
        if (!orderResult.recordset[0]) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const maxResult = await transaction.request()
            .input("orderNo", orderNo)
            .query("SELECT ISNULL(MAX(serialNo), 0) AS maxSerial FROM dbo.orderdetails WHERE orderNo = @orderNo");
        const serialNo = maxResult.recordset[0].maxSerial + 1;
        const barcode = buildBarcode(orderNo, serialNo);
        const sUser = await resolveUsername(req);

        await transaction.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("Prudact", Prudact || null)
            .input("field1", field1 || null)
            .input("field2", field2 || null)
            .input("itemNo", itemNo || null)
            .input("note", note || null)
            .input("barcode", barcode)
            .input("sUser", sUser)
            .query(`
                INSERT INTO dbo.orderdetails
                    (orderNo, serialNo, Prudact, [1], [2], itemNo, note, barcode, SUser, SDate)
                VALUES
                    (@orderNo, @serialNo, @Prudact, @field1, @field2, @itemNo, @note, @barcode, @sUser, GETDATE())
            `);

        await transaction.commit();
        res.status(201).json({ success: true, serialNo, barcode });
    } catch (err) {
        if (transaction) { try { await transaction.rollback(); } catch { /* already rolled back */ } }
        console.error("❌ PROJ ORDER ITEM CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create order item" });
    }
});

// PUT /api/proj-orders/:orderNo/items/:serialNo — edit an order line.
// Confirmed none of Prudact/[1]/[2]/itemNo/note are read into any
// calculation in this file — all five are opaque descriptive fields, so
// unlike the order header above, no field needs to be excluded here.
router.put("/:orderNo/items/:serialNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const { Prudact, field1, field2, itemNo, note } = req.body;

    try {
        const result = await withSqlRetry("proj", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("Prudact", Prudact || null)
            .input("field1", field1 || null)
            .input("field2", field2 || null)
            .input("itemNo", itemNo || null)
            .input("note", note || null)
            .query(`
                UPDATE dbo.orderdetails
                SET Prudact = @Prudact, [1] = @field1, [2] = @field2, itemNo = @itemNo, note = @note
                WHERE orderNo = @orderNo AND serialNo = @serialNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Item not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROJ ORDER ITEM UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order item" });
    }
});

// --- Order notes (dbo.D1) -------------------------------------------------
// Confirmed live: dbo.D1 is a real, heavily-used table (8000+ rows) — the
// legacy Access app's generic per-order note log (its D2-D5 siblings are
// near-identical but far less used — 278/224/6/5 rows respectively — D1 is
// clearly the one this app should target). Real rows show a request/resolve
// pattern: Ditails/DitalsDate holds the original note (e.g. materials
// needed), Action/ActionDate get filled in later once someone resolves it
// (real values seen live: "متوفر"/"غير متوفر" — "available"/"not
// available") — both are nullable and optional at creation for that reason,
// not because they're unimportant. Si is a real identity column here
// (unlike OrdersBack's Si) — OUTPUT INSERTED.Si is safe to use directly.
router.get("/:orderNo/notes", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo, 10);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const pool = await getSqlPool("proj");
        const result = await pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT Si, Ditails, DitalsDate, Action, ActionDate, SUser, SDate
                FROM dbo.D1
                WHERE orderno = @orderNo
                ORDER BY SDate DESC
            `);

        // dbo.x1's Note/OrederPlace fields are pulled in alongside the D1 log
        // here purely because the legacy Access report this print view
        // replaces (Report_D1, confirmed live via its D1R() RecordSource —
        // "...D1.ActionDate FROM orders INNER JOIN (x1 INNER JOIN D1 ON
        // x1.orderno=D1.orderno) ...") joins the same two tables for the
        // same order. x1 is otherwise the unrelated, unbuilt "per-department
        // event log" gap (x1-x5) noted elsewhere in this file — only these
        // two flat fields are used, not the xc1-5/x1-3 stage columns.
        const x1Result = await pool.request()
            .input("orderNo", orderNo)
            .query("SELECT TOP 1 Note, OrederPlace FROM dbo.x1 WHERE orderno = @orderNo");

        res.json({ success: true, notes: result.recordset, x1: x1Result.recordset[0] || null });
    } catch (err) {
        console.error("❌ PROJ ORDER NOTES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order notes" });
    }
});

router.post("/:orderNo/notes", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { ditails, ditalsDate, action, actionDate } = req.body;
    if (!ditails || !String(ditails).trim()) {
        return res.status(400).json({ success: false, message: "ditails is required" });
    }

    try {
        const pool = await getSqlPool("proj");

        const orderResult = await pool.request()
            .input("orderNo", orderNo)
            .query("SELECT orderNo FROM dbo.orders WHERE orderNo = @orderNo");
        if (!orderResult.recordset[0]) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("orderNo", orderNo)
            .input("ditails", String(ditails).trim())
            .input("ditalsDate", ditalsDate || null)
            .input("action", action || null)
            .input("actionDate", actionDate || null)
            .input("sUser", sUser)
            .query(`
                INSERT INTO dbo.D1 (orderno, Ditails, DitalsDate, Action, ActionDate, SUser, SDate)
                OUTPUT INSERTED.Si
                VALUES (@orderNo, @ditails, @ditalsDate, @action, @actionDate, @sUser, GETDATE())
            `);

        res.status(201).json({ success: true, si: result.recordset[0].Si });
    } catch (err) {
        console.error("❌ PROJ ORDER NOTE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to add order note" });
    }
});

// --- Returns (dbo.OrdersBack) --------------------------------------------
// Confirmed live: this table had zero rows at the time this was built (the
// legacy Access "OrdersBack"/"المرتجع" form exists but nobody had used it),
// so there's no real data to learn field conventions from — OrderNO/UNNO/
// Back are accepted as free text because that's genuinely what the schema
// is (nvarchar, not FK-typed columns), not because validation was skipped.
// SI is the primary key but is NOT a SQL Server identity column (also
// confirmed live) — the legacy app must have computed it manually, so this
// does the same (MAX(SI)+1 inside a transaction, same pattern glass.js uses
// for Sorderdetails.serialNo).

// GET /api/proj-orders/returns?search=&page=&pageSize=
router.get("/returns", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        const whereClause = search ? "WHERE OrderNO LIKE @search OR OrderName LIKE @search" : "";

        const countRequest = pool.request();
        if (search) countRequest.input("search", `%${search}%`);
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.OrdersBack ${whereClause}`);
        const total = countResult.recordset[0].total;

        const rowsRequest = pool.request();
        rowsRequest.input("offset", offset).input("pageSize", pageSize);
        if (search) rowsRequest.input("search", `%${search}%`);
        const rowsResult = await rowsRequest.query(`
            SELECT SI, OrderName, OrderNO, OrderManger, Back, Qty, UNNO, Date, note
            FROM dbo.OrdersBack
            ${whereClause}
            ORDER BY SI DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, returns: rowsResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROJ ORDER RETURNS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch returns" });
    }
});

// POST /api/proj-orders/returns — record a returned/rejected unit. When
// orderNo matches a real dbo.orders row, OrderName/OrderManger are taken
// from there (mirrors stockHouse.js's resolveProject — don't trust
// free-text project name/manager from the client over real order data);
// otherwise falls back to whatever the caller supplied, since OrderNO here
// isn't actually constrained to reference a real order.
router.post("/returns", async (req, res) => {
    const { orderNo, orderName, orderManager, back, qty, unno, note } = req.body;
    if (!orderNo || !String(orderNo).trim()) {
        return res.status(400).json({ success: false, message: "orderNo is required" });
    }

    try {
        const pool = await getSqlPool("proj");

        let resolvedOrderName = orderName || null;
        let resolvedOrderManager = orderManager || null;
        const parsedOrderNo = parseInt(orderNo, 10);
        if (Number.isInteger(parsedOrderNo)) {
            const orderLookup = await pool.request()
                .input("orderNo", parsedOrderNo)
                .query("SELECT projName, projMgr FROM dbo.orders WHERE orderNo = @orderNo");
            if (orderLookup.recordset[0]) {
                resolvedOrderName = orderLookup.recordset[0].projName;
                resolvedOrderManager = orderLookup.recordset[0].projMgr;
            }
        }

        const transaction = pool.transaction();
        await transaction.begin();
        let si;
        try {
            const maxResult = await transaction.request()
                .query("SELECT ISNULL(MAX(SI), 0) AS maxSi FROM dbo.OrdersBack");
            si = maxResult.recordset[0].maxSi + 1;

            await transaction.request()
                .input("si", si)
                .input("orderName", resolvedOrderName)
                .input("orderNo", String(orderNo).trim())
                .input("orderManger", resolvedOrderManager)
                .input("back", back || null)
                .input("qty", qty !== undefined && qty !== null && qty !== "" ? parseInt(qty, 10) : null)
                .input("unno", unno || null)
                .input("note", note || null)
                .query(`
                    INSERT INTO dbo.OrdersBack (SI, OrderName, OrderNO, OrderManger, Back, Qty, UNNO, Date, note)
                    VALUES (@si, @orderName, @orderNo, @orderManger, @back, @qty, @unno, GETDATE(), @note)
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({ success: true, si, orderName: resolvedOrderName, orderManager: resolvedOrderManager });
    } catch (err) {
        console.error("❌ PROJ ORDER RETURN CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record return" });
    }
});

// --- Worker time log (dbo.FactoryAll / dbo.worker) ------------------------
// Confirmed live which table is real: dbo.FactoryAll has 59,543 rows and is
// actively written to today. Its three lookalikes — "Factory - OLD",
// "Factory --test", "FactoryF - OLD" — are explicitly named as deprecated/
// test in SQL Server itself, not just guessed to be; FactoryAll is the
// unified, current table (its name says as much) and the only one used here.
//
// Section is a controlled value, not free text — confirmed live only 'S'
// and 'F' occur (~20k and ~38k rows respectively, some null), matching the
// legacy forms' two departments ("قسم السحابات"/"قسم الفصالات"). dbo.worker
// carries each worker's own Section, so a picked worker's Section is used
// server-side rather than trusted from the client, same "don't trust
// free text over real data" principle as the returns/reservation lookups.
//
// WorkerName is null on every real row sampled — current practice
// identifies a worker by EmpNo (cross-checked live: FactoryAll.EmpNo values
// match dbo.worker.EmpNo, not dbo.worker.NO). This still writes WorkerName
// for new rows since a readable name costs nothing and only helps this UI's
// own list — it doesn't break the established EmpNo-based lookup pattern.
//
// StartTime/EndTime store time-of-day only, using the classic Access
// OLE-date trick (1899-12-30 + a time) — confirmed live, e.g.
// "1899-12-30T08:00:00.000Z" for an 8:00 AM shift start — so this app does
// the same rather than storing a real clock-in timestamp.
//
// RequerTime/WorkTime/Fi/Efc: an earlier pass over this table sampled a
// handful of rows and found these null, and guessed they were filled by an
// unknown batch job. A fuller query proved that guess wrong — ~95% of rows
// have them populated — and reading the legacy Access app's own VBA (as
// plain text via COM, never executed; see worker efficiency section below
// for how) settled it for real: WorkTime is auto-computed here from
// StartTime/EndTime at creation time, matching the legacy form's own
// EndTime_AfterUpdate logic exactly.
const ACCESS_TIME_EPOCH = "1899-12-30"; // OLE Automation date zero
const BRICK_TIME_MINUTES = 12 * 60; // "BrickTime" — confirmed live: fixed at 12:00:00 (lunch) on 59,565 of 59,566 rows

function timeToMinutes(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + m;
}

// Confirmed from Form_Factory's EndTime_AfterUpdate VBA (read as plain text,
// never executed): the raw StartTime->EndTime span in minutes, minus a
// 30-minute lunch deduction only when the span crosses the BrickTime
// threshold — verified against live StartTime/EndTime/BrickTime/WorkTime
// rows (e.g. 08:00-16:30 crossing 12:00 -> 510-30=480, matching the stored
// WorkTime exactly).
function computeWorkTime(startTime, endTime) {
    const start = timeToMinutes(startTime);
    const end = timeToMinutes(endTime);
    const diff = end - start;
    const crossesBrick = start <= BRICK_TIME_MINUTES && end > BRICK_TIME_MINUTES;
    return crossesBrick ? diff - 30 : diff;
}

router.get("/workers", async (req, res) => {
    try {
        const section = req.query.section ? String(req.query.section).trim() : null;
        const pool = await getSqlPool("proj");
        const request = pool.request();
        let sectionFilter = "";
        if (section) {
            request.input("section", section);
            sectionFilter = "AND Section = @section";
        }
        const result = await request.query(`
            SELECT NO, Workers, EmpNo, Section
            FROM dbo.worker
            WHERE UPPER(Active) = 'YES' ${sectionFilter}
            ORDER BY Workers
        `);
        res.json({ success: true, workers: result.recordset });
    } catch (err) {
        console.error("❌ PROJ WORKERS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch workers" });
    }
});

router.get("/worker-time", async (req, res) => {
    try {
        const section = req.query.section ? String(req.query.section).trim() : null;
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        // filters is rebuilt fresh on every buildRequest() call (not
        // accumulated across calls) — whereClause() re-reads it lazily each
        // time it's invoked, since buildRequest() must actually run first to
        // populate it (a plain precomputed string here would always see an
        // empty array and silently produce no WHERE clause at all).
        let filters = [];
        const buildRequest = () => {
            filters = [];
            const request = pool.request();
            if (section) {
                request.input("section", section);
                filters.push("Section = @section");
            }
            if (search) {
                request.input("search", `%${search}%`);
                filters.push("(WorkerName LIKE @search OR ProjNO LIKE @search OR JobeDeisc LIKE @search)");
            }
            return request;
        };
        const whereClause = () => (filters.length ? `WHERE ${filters.join(" AND ")}` : "");

        const countRequest = buildRequest();
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.FactoryAll ${whereClause()}`);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT
                SNO, Date1, WorkerName, EmpNo, Section, orderNo, ProjNO,
                ProdectTybe, JobeDeisc, jobe, StartTime, EndTime, note, SUser, SDate
            FROM dbo.FactoryAll
            ${whereClause()}
            ORDER BY SDate DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, entries: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROJ WORKER TIME LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch worker time entries" });
    }
});

router.post("/worker-time", async (req, res) => {
    const { empNo, projNo, orderNo, prodectTybe, jobeDeisc, jobe, startTime, endTime, note } = req.body;
    const parsedEmpNo = parseInt(empNo, 10);
    if (!Number.isInteger(parsedEmpNo)) {
        return res.status(400).json({ success: false, message: "empNo is required" });
    }

    try {
        const pool = await getSqlPool("proj");

        const workerLookup = await pool.request()
            .input("empNo", parsedEmpNo)
            .query("SELECT TOP 1 Workers, Section FROM dbo.worker WHERE EmpNo = @empNo");
        const worker = workerLookup.recordset[0];
        if (!worker) {
            return res.status(404).json({ success: false, message: "Worker not found" });
        }

        const sUser = await resolveUsername(req);
        const workTime = startTime && endTime ? computeWorkTime(startTime, endTime) : null;
        const result = await pool.request()
            .input("date1", new Date())
            .input("workerName", worker.Workers)
            .input("empNo", parsedEmpNo)
            .input("section", worker.Section)
            .input("orderNo", orderNo || null)
            .input("projNo", projNo || null)
            .input("prodectTybe", prodectTybe || null)
            .input("jobeDeisc", jobeDeisc || null)
            .input("jobe", jobe || null)
            .input("startTime", startTime ? `${ACCESS_TIME_EPOCH} ${startTime}` : null)
            .input("endTime", endTime ? `${ACCESS_TIME_EPOCH} ${endTime}` : null)
            .input("workTime", workTime)
            .input("note", note || null)
            .input("sUser", sUser)
            .query(`
                INSERT INTO dbo.FactoryAll
                    (Date1, WorkerName, EmpNo, Section, orderNo, ProjNO, ProdectTybe, JobeDeisc, jobe,
                     StartTime, EndTime, WorkTime, note, SUser, SDate)
                OUTPUT INSERTED.SNO
                VALUES
                    (@date1, @workerName, @empNo, @section, @orderNo, @projNo, @prodectTybe, @jobeDeisc, @jobe,
                     @startTime, @endTime, @workTime, @note, @sUser, GETDATE())
            `);

        res.status(201).json({ success: true, sno: result.recordset[0].SNO, workerName: worker.Workers, section: worker.Section, workTime });
    } catch (err) {
        console.error("❌ PROJ WORKER TIME CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to log worker time entry" });
    }
});

// --- Worker efficiency (dbo.FactoryAll.RequerTime/Fi/Efc) ------------------
// Confirmed from two independent sources that agree exactly: (1) the live
// dbo.EFCS/dbo.EFCF SQL Server views' OBJECT_DEFINITION — Efc column is
// stored, and [EFC/D] = RequerTime * Fi is computed in the view; (2) the
// legacy Access app's own VBA behind the "Factory"/"FactoryF" forms (opened
// via double-click from Worker1/WorkerF1), read as plain text through COM
// Design-view automation — never executed — which has
// Private Sub Fi_AfterUpdate(): Me.Efc = Me.Fi * Me.RequerTime / Me.WorkTime.
// RequerTime (required/standard minutes for the job) and Fi (a completion
// factor entered per job) are typed in on that supervisor-facing detail form
// after the fact, not at clock-in time on Worker1/WorkerF1 — those two forms
// have no control bound to either field (confirmed by enumerating every
// control on both). Efc is therefore always derived, never entered directly
// by a user in this app either — this endpoint recomputes and stores it
// server-side rather than trusting a client-supplied value.
router.post("/worker-time/:sno/efficiency", async (req, res) => {
    const sno = parseInt(req.params.sno, 10);
    const parsedRequerTime = parseInt(req.body.requerTime, 10);
    const parsedFi = parseFloat(req.body.fi);
    if (!Number.isInteger(sno)) {
        return res.status(400).json({ success: false, message: "Invalid entry" });
    }
    if (!Number.isFinite(parsedRequerTime) || parsedRequerTime < 0) {
        return res.status(400).json({ success: false, message: "Required time must be a non-negative number" });
    }
    if (!Number.isFinite(parsedFi) || parsedFi < 0) {
        return res.status(400).json({ success: false, message: "Completion factor must be a non-negative number" });
    }

    try {
        const pool = await getSqlPool("proj");
        const existing = await pool.request()
            .input("sno", sno)
            .query("SELECT WorkTime FROM dbo.FactoryAll WHERE SNO = @sno");
        const row = existing.recordset[0];
        if (!row) {
            return res.status(404).json({ success: false, message: "Time entry not found" });
        }
        if (!row.WorkTime) {
            return res.status(400).json({
                success: false,
                message: "This entry has no work time yet (missing start/end time) — efficiency can't be computed",
            });
        }

        const efc = (parsedFi * parsedRequerTime) / row.WorkTime;

        await pool.request()
            .input("sno", sno)
            .input("requerTime", parsedRequerTime)
            .input("fi", parsedFi)
            .input("efc", efc)
            .query("UPDATE dbo.FactoryAll SET RequerTime = @requerTime, Fi = @fi, Efc = @efc WHERE SNO = @sno");

        res.json({ success: true, workTime: row.WorkTime, efc });
    } catch (err) {
        console.error("❌ PROJ WORKER EFFICIENCY UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update efficiency" });
    }
});

// GET /api/proj-orders/efficiency?section=&search=&dateFrom=&dateTo=&groupBy=job|day&page=&pageSize=
// groupBy=job (default) mirrors dbo.EFCS/dbo.EFCF row-for-row (same join,
// same "Fi <> 0" filter) rather than reimplementing the aggregation
// independently — this is the legacy forms' "الكفأة حسب العمل" (per-job)
// view. groupBy=day aggregates to one row per worker per date (sum of earned
// time over sum of worked time) — the "الكفأة اليومية" (daily) view the same
// legacy pivot forms exposed alongside the per-job one.
router.get("/efficiency", async (req, res) => {
    try {
        const section = req.query.section ? String(req.query.section).trim() : null;
        const search = String(req.query.search || "").trim();
        const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : null;
        const dateTo = req.query.dateTo ? String(req.query.dateTo) : null;
        const groupBy = req.query.groupBy === "day" ? "day" : "job";
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        let filters = [];
        const buildRequest = () => {
            filters = ["f.Fi <> 0"];
            const request = pool.request();
            if (section) {
                request.input("section", section);
                filters.push("f.Section = @section");
            }
            if (search) {
                request.input("search", `%${search}%`);
                filters.push("w.Workers LIKE @search");
            }
            if (dateFrom) {
                request.input("dateFrom", dateFrom);
                filters.push("f.Date1 >= @dateFrom");
            }
            if (dateTo) {
                request.input("dateTo", dateTo);
                filters.push("f.Date1 <= @dateTo");
            }
            return request;
        };
        const whereClause = () => `WHERE ${filters.join(" AND ")}`;

        if (groupBy === "day") {
            const countRequest = buildRequest();
            const countResult = await countRequest.query(`
                SELECT COUNT(*) AS total FROM (
                    SELECT w.Workers, f.Section, CAST(f.Date1 AS date) AS d
                    FROM dbo.worker w LEFT JOIN dbo.FactoryAll f ON w.EmpNo = f.EmpNo
                    ${whereClause()}
                    GROUP BY w.Workers, f.Section, CAST(f.Date1 AS date)
                ) x
            `);
            const total = countResult.recordset[0].total;

            const listRequest = buildRequest();
            listRequest.input("offset", offset).input("pageSize", pageSize);
            const listResult = await listRequest.query(`
                SELECT
                    w.Workers AS WorkerName, f.Section, CAST(f.Date1 AS date) AS Date1,
                    SUM(f.WorkTime) AS WorkTime,
                    SUM(f.RequerTime * f.Fi) / NULLIF(SUM(f.WorkTime), 0) AS Efc
                FROM dbo.worker w LEFT JOIN dbo.FactoryAll f ON w.EmpNo = f.EmpNo
                ${whereClause()}
                GROUP BY w.Workers, f.Section, CAST(f.Date1 AS date)
                ORDER BY CAST(f.Date1 AS date) DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            res.json({ success: true, entries: listResult.recordset, total, page, pageSize, groupBy });
            return;
        }

        const countRequest = buildRequest();
        const countResult = await countRequest.query(`
            SELECT COUNT(*) AS total
            FROM dbo.worker w LEFT JOIN dbo.FactoryAll f ON w.EmpNo = f.EmpNo
            ${whereClause()}
        `);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT f.SNO, w.Workers AS WorkerName, f.Date1, f.Section, f.WorkTime, f.RequerTime, f.Fi, f.Efc
            FROM dbo.worker w LEFT JOIN dbo.FactoryAll f ON w.EmpNo = f.EmpNo
            ${whereClause()}
            ORDER BY f.Date1 DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, entries: listResult.recordset, total, page, pageSize, groupBy });
    } catch (err) {
        console.error("❌ PROJ EFFICIENCY LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch efficiency data" });
    }
});

// --- Cutting / distribution schedules (dbo.Cut, dbo.Redy) -----------------
// Confirmed live: both tables exist but have zero rows — genuinely unused
// in current practice, same situation as OrdersBack was. Neither has an
// identity column or any other primary key (also confirmed live), so —
// like OrdersBack before its SI column was found to need manual
// MAX+1 — there's no per-row identifier to update or delete against; this
// is a pure append-only log, matching how a no-PK table would have to be
// used from Access itself (bound directly to the whole table, no way to
// address "this one row" except by re-querying on the fields you just
// typed). projName is looked up from dbo.orders when projNo+ProdctionNO
// matches a real order, same "don't trust free text over real data"
// principle as returns/reservations — Cut/Redy are scoped to a production
// order the same way ReservationF is (project + production number, not
// just project). Cut's extra "Saction" column has no live data and no
// caption text to clarify it beyond the legacy form's raw field name, so
// it's exposed as a plain optional field on the API rather than guessed
// at — but the column itself is NOT NULL (confirmed live, the hard way: a
// blank value 500'd with "Cannot insert the value NULL into column
// 'Saction'"), so an empty string is written when the caller leaves it out,
// not null.
async function resolveOrderByProduction(pool, projNo, productionNo) {
    const result = await pool.request()
        .input("projNo", projNo)
        .input("productionNo", productionNo)
        .query("SELECT TOP 1 projName FROM dbo.orders WHERE projNo = @projNo AND ProdctionNO = @productionNo ORDER BY orderNo DESC");
    return result.recordset[0]?.projName ?? null;
}

router.get("/cut-schedule", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        const whereClause = search ? "WHERE projNo LIKE @search OR projName LIKE @search" : "";

        const countRequest = pool.request();
        if (search) countRequest.input("search", `%${search}%`);
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.Cut ${whereClause}`);
        const total = countResult.recordset[0].total;

        const listRequest = pool.request();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        if (search) listRequest.input("search", `%${search}%`);
        const listResult = await listRequest.query(`
            SELECT Date1, projNo, projName, ProdctionNO, Saction, Tayb, Date, Note
            FROM dbo.Cut
            ${whereClause}
            ORDER BY Date1 DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, entries: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROJ CUT SCHEDULE LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch cutting schedule" });
    }
});

router.post("/cut-schedule", async (req, res) => {
    const { projNo, productionNo, tayb, saction, date, note } = req.body;
    if (!projNo || !String(projNo).trim() || !productionNo || !String(productionNo).trim()) {
        return res.status(400).json({ success: false, message: "projNo and productionNo are required" });
    }
    if (!tayb || !String(tayb).trim()) {
        return res.status(400).json({ success: false, message: "tayb is required" });
    }

    try {
        const pool = await getSqlPool("proj");
        const projName = await resolveOrderByProduction(pool, String(projNo).trim(), String(productionNo).trim());

        await pool.request()
            .input("projNo", String(projNo).trim())
            .input("projName", projName)
            .input("productionNo", String(productionNo).trim())
            .input("saction", saction || "")
            .input("tayb", String(tayb).trim())
            .input("date", date || null)
            .input("note", note || null)
            .query(`
                INSERT INTO dbo.Cut (Date1, projNo, projName, ProdctionNO, Saction, Tayb, Date, Note)
                VALUES (GETDATE(), @projNo, @projName, @productionNo, @saction, @tayb, @date, @note)
            `);

        res.status(201).json({ success: true, projName });
    } catch (err) {
        console.error("❌ PROJ CUT SCHEDULE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to log cutting schedule entry" });
    }
});

router.get("/distribution-schedule", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        const whereClause = search ? "WHERE projNo LIKE @search OR projName LIKE @search" : "";

        const countRequest = pool.request();
        if (search) countRequest.input("search", `%${search}%`);
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.Redy ${whereClause}`);
        const total = countResult.recordset[0].total;

        const listRequest = pool.request();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        if (search) listRequest.input("search", `%${search}%`);
        const listResult = await listRequest.query(`
            SELECT Date1, projNo, projName, ProdctionNO, Tayb, Date, Note
            FROM dbo.Redy
            ${whereClause}
            ORDER BY Date1 DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, entries: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROJ DISTRIBUTION SCHEDULE LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch distribution schedule" });
    }
});

router.post("/distribution-schedule", async (req, res) => {
    const { projNo, productionNo, tayb, date, note } = req.body;
    if (!projNo || !String(projNo).trim() || !productionNo || !String(productionNo).trim()) {
        return res.status(400).json({ success: false, message: "projNo and productionNo are required" });
    }
    if (!tayb || !String(tayb).trim()) {
        return res.status(400).json({ success: false, message: "tayb is required" });
    }

    try {
        const pool = await getSqlPool("proj");
        const projName = await resolveOrderByProduction(pool, String(projNo).trim(), String(productionNo).trim());

        await pool.request()
            .input("projNo", String(projNo).trim())
            .input("projName", projName)
            .input("productionNo", String(productionNo).trim())
            .input("tayb", String(tayb).trim())
            .input("date", date || null)
            .input("note", note || null)
            .query(`
                INSERT INTO dbo.Redy (Date1, projNo, projName, ProdctionNO, Tayb, Date, Note)
                VALUES (GETDATE(), @projNo, @projName, @productionNo, @tayb, @date, @note)
            `);

        res.status(201).json({ success: true, projName });
    } catch (err) {
        console.error("❌ PROJ DISTRIBUTION SCHEDULE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to log distribution schedule entry" });
    }
});

// --- Per-unit production checklist (dbo.details) --------------------------
// Confirmed live this is NOT a "15-slot dimension breakdown" as its column
// names alone suggested — it's a per-unit factory production-stage
// checklist. Reverse-engineered the actual meaning of each D/N slot by
// reading the legacy Access form's own on-screen label captions (LabelN1..
// LabelN15) via Design-view COM inspection, not guessed from field names:
// stages 1-10 have distinct real captions (frame/panel assembly, glass,
// weights, drainage, mesh/screen, glass template); stages 11-15 all share
// the same "تركيب الزجاج"/"تركيب زجاج" ("install glass") caption verbatim —
// almost certainly unused/copy-pasted overflow slots in the legacy form,
// not five distinct real stages, so they're labeled here as "(extra)" to
// avoid implying they're each meaningfully different from stage 4.
//
// orderNo+serialNo is the primary key — one row per unit, not one row per
// event — confirmed live (57,663 total rows for years of production, not
// 57,663 events for a handful of units). D_i/N_i are written together as a
// pair when a stage is marked done (D_i=-1, N_i=1) or undone (both 0) —
// confirmed from the total1 completion-percentage formula on the same form,
// which treats D_i<0 as "this stage counts toward the denominator" and
// sums N_i as the numerator. This mutates one column pair on the unit's
// single row rather than appending a new row, so unlike every other
// feature in this file, marking a stage requires an upsert (create the row
// on the unit's first stage, update it on every stage after that) instead
// of a plain INSERT.
const UNIT_STAGE_LABELS = [
    "تجهيز وجمع الحلق",       // 1 — prepare & assemble frame
    "تجهيز وجمع الدرف",       // 2 — prepare & assemble panels/leaves
    "تركيب بيشة",             // 3 — install [hardware component]
    "تركيب الزجاج",           // 4 — install glass
    "شرح وتجهيز تكملة منخل",  // 5 — mark & prep mesh/screen completion
    "تجهيز وجمع وشد منخل",    // 6 — prepare/assemble/tension mesh/screen
    "تركيب ثقالات",           // 7 — install counterweights
    "فرز زرفيل",              // 8 — sort [hardware component]
    "فرز ماء للحلق والدرفة",  // 9 — prep drainage for frame & panel
    "تجهيز طبعة زجاج",        // 10 — prepare glass template
    "تركيب زجاج (إضافي)",     // 11 — "install glass" verbatim on the form, see note above
    "تركيب الزجاج (إضافي)",   // 12
    "تركيب الزجاج (إضافي)",   // 13
    "تركيب الزجاج (إضافي)",   // 14
    "تركيب الزجاج (إضافي)",   // 15
];

router.get("/:orderNo/units/:serialNo/progress", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }

    try {
        const pool = await getSqlPool("proj");
        const result = await pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .query("SELECT * FROM dbo.details WHERE orderNo = @orderNo AND serialNo = @serialNo");
        const row = result.recordset[0] || null;

        const stages = UNIT_STAGE_LABELS.map((label, i) => {
            const n = i + 1;
            return {
                stage: n,
                label,
                done: row ? row[`D${n}`] === -1 : false,
                note: row ? row[`Notic${n}`] : null,
            };
        });

        res.json({ success: true, stages });
    } catch (err) {
        console.error("❌ PROJ UNIT PROGRESS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch unit progress" });
    }
});

router.post("/:orderNo/units/:serialNo/progress/:stage", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    const stage = parseInt(req.params.stage, 10);
    const { done } = req.body;
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    if (!Number.isInteger(stage) || stage < 1 || stage > 15) {
        return res.status(400).json({ success: false, message: "stage must be between 1 and 15" });
    }

    try {
        const pool = await getSqlPool("proj");
        const dCol = `D${stage}`;
        const nCol = `N${stage}`;
        const dVal = done ? -1 : 0;
        const nVal = done ? 1 : 0;

        const existing = await pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .query("SELECT orderNo FROM dbo.details WHERE orderNo = @orderNo AND serialNo = @serialNo");

        if (existing.recordset[0]) {
            // stage is validated as an integer 1-15 above, so it's safe to
            // interpolate into the column identifier here — never built
            // from unvalidated input.
            await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .input("dVal", dVal)
                .input("nVal", nVal)
                .query(`UPDATE dbo.details SET [${dCol}] = @dVal, [${nCol}] = @nVal WHERE orderNo = @orderNo AND serialNo = @serialNo`);
        } else {
            const sUser = await resolveUsername(req);
            await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .input("dVal", dVal)
                .input("nVal", nVal)
                .input("sUser", sUser)
                .query(`INSERT INTO dbo.details (orderNo, serialNo, [${dCol}], [${nCol}], SUser, SDate) VALUES (@orderNo, @serialNo, @dVal, @nVal, @sUser, GETDATE())`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROJ UNIT PROGRESS UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update unit progress" });
    }
});

// --- Per-unit cutting/collecting status (dbo.Process) -----------------------
// A second, separate per-unit tracking mechanism from dbo.details above —
// confirmed live these are genuinely different tables/concepts (57,373 live
// Process rows, one per unit, tracked independently of the 15-stage details
// checklist). Only ever exposed before as an order-level average via
// OrderCH's Expr1/Expr2 (cutting %/collecting %) — no per-unit view/edit
// existed. Field captions confirmed via Design-view COM inspection of the
// legacy "Process" form (the app's own VBA project is password-protected,
// so sub-level code couldn't be read, but control Captions/RecordSource are
// unaffected by that lock): Cuting="القص" (cutting), Colcting="الجمع"
// (collecting/assembly — a different word from Iron's own ProcessI.Colcting,
// which is "التجهيز"/preparation; don't assume the two modules mean the same
// thing despite the shared column name). note="ملاحظات خلال عملية الانتاج"
// (notes during the production process). DateFinsh/finaldate map to two
// distinct captions — "تارخ الانجاز" (completion date) and "موعد الانتهاء"
// (finish appointment/target date) respectively — inferred pairing (not
// 100% confirmed since the VBA lock prevents seeing which control is bound
// to which field), exposed as separate date/targetDate fields rather than
// guessed-and-merged. Tik1-4 (paired "Ready"/"Stopped" toggles for
// Aluminum/Accessory work, per the form's own Label55/57/59/61/64/65
// captions) are confirmed live to be 100% unused (0 non-null across all
// 57,373 rows) — not exposed here, same treatment as Iron's xc4/xc5.
router.get("/:orderNo/units/:serialNo/process", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }

    try {
        const result = await withSqlRetry("proj", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .query("SELECT Cuting, Colcting, Date, note, DateFinsh, finaldate FROM dbo.Process WHERE orderNo = @orderNo AND serialNo = @serialNo"));
        const row = result.recordset[0] || null;

        res.json({
            success: true,
            status: {
                cuting: row ? !!row.Cuting : false,
                colcting: row ? !!row.Colcting : false,
                date: row ? row.Date : null,
                note: row ? row.note : null,
                completionDate: row ? row.DateFinsh : null,
                targetDate: row ? row.finaldate : null,
            },
        });
    } catch (err) {
        console.error("❌ PROJ UNIT PROCESS STATUS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch unit process status" });
    }
});

router.post("/:orderNo/units/:serialNo/process", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const { cuting, colcting, note, completionDate, targetDate } = req.body;

    try {
        const cutingVal = cuting ? 1 : 0;
        const colctingVal = colcting ? 1 : 0;

        // Fully idempotent (sets absolute values, no increment) so safe to
        // retry the whole existing-check + update-or-insert as one block.
        await withSqlRetry("proj", async (pool) => {
            const existing = await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .query("SELECT orderNo FROM dbo.Process WHERE orderNo = @orderNo AND serialNo = @serialNo");

            if (existing.recordset[0]) {
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("cuting", cutingVal)
                    .input("colcting", colctingVal)
                    .input("note", note || null)
                    .input("completionDate", completionDate || null)
                    .input("targetDate", targetDate || null)
                    .input("date", new Date())
                    .query(`
                        UPDATE dbo.Process
                        SET Cuting = @cuting, Colcting = @colcting, note = @note,
                            DateFinsh = @completionDate, finaldate = @targetDate, Date = @date
                        WHERE orderNo = @orderNo AND serialNo = @serialNo
                    `);
            } else {
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("cuting", cutingVal)
                    .input("colcting", colctingVal)
                    .input("note", note || null)
                    .input("completionDate", completionDate || null)
                    .input("targetDate", targetDate || null)
                    .input("date", new Date())
                    .query(`
                        INSERT INTO dbo.Process (orderNo, serialNo, Cuting, Colcting, note, DateFinsh, finaldate, Date)
                        VALUES (@orderNo, @serialNo, @cuting, @colcting, @note, @completionDate, @targetDate, @date)
                    `);
            }
        });

        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROJ UNIT PROCESS UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update unit process status" });
    }
});

// --- Per-department event log (dbo.x1 - dbo.x5) ----------------------------
// Confirmed live via read-only Design-view COM inspection of the legacy
// forms "x1".."x5" (never opened in Form/Datasheet view, no macros/VBA
// executed): these are five near-identical per-department checklists, one
// row per order per department (orderno is each table's real, non-identity
// primary key — confirmed one-to-one with distinct order counts, not
// append-only like Cut/Redy). Real form-header captions name the five
// departments unambiguously: x1="سجل احداث الالمنيوم" (Aluminum),
// x2="سجل احداث الزجاج" (Glass), x3="...صاج+حديد" (Sheet Metal + Iron),
// x4="...اعمال المنجرة" (Carpentry), x5="...اعمال المخرطة" (Lathe).
//
// Each form has exactly 3 checkboxes (xcN1-3, the classic Access -1/0
// boolean convention — confirmed live, only those two values occur) and 2
// numeric fields — but the form's own labels for those numeric fields are
// literally "x1"/"x2" (confirmed live: the Label controls' .Caption is the
// bare field name, not a real word) — that's what real users see today, not
// a placeholder invented here, so this exposes them the same way rather
// than inventing more specific labels the legacy app itself never gave
// them. A third "xN3" field (datetime) was confirmed to always duplicate
// the completion date column on every populated row sampled, so it's not
// surfaced separately — writes just mirror it into that column alongside.
// x1 alone carries extra Note/OrederPlace/Place1/Place2 fields (already
// surfaced read-only in the D1 report above); x2 alone carries its own
// denormalized ProjNO/ProdNO columns, resolved server-side from dbo.orders
// like every other lookup in this file rather than trusted from the client.
// x3's form additionally binds projNo/ProdctionNO controls, but those are
// confirmed (via its RecordSource) to be read-only display fields joined in
// from dbo.orders, not real x3 columns — nothing to write there.
const DEPARTMENT_LOG_CONFIG = {
    1: { table: "x1", checkboxCols: ["xc1", "xc2", "xc3"], valueCols: ["x1", "x2"], extraDateCol: "x3", dateCol: "date", checkboxIsString: true, hasNote: true },
    2: { table: "x2", checkboxCols: ["xc12", "xc22", "xc32"], valueCols: ["x12", "x22"], extraDateCol: "x32", dateCol: "date2", hasProjLookup: true },
    3: { table: "x3", checkboxCols: ["xc13", "xc23", "xc33"], valueCols: ["x13", "x23"], extraDateCol: "x33", dateCol: "date3" },
    4: { table: "x4", checkboxCols: ["xc14", "xc24", "xc34"], valueCols: ["x14", "x24"], extraDateCol: "x34", dateCol: "date4" },
    5: { table: "x5", checkboxCols: ["xc15", "xc25", "xc35"], valueCols: ["x15", "x25"], extraDateCol: "x35", dateCol: "date5" },
};
const DEPARTMENT_NAMES = { 1: "Aluminum", 2: "Glass", 3: "Sheet Metal + Iron", 4: "Carpentry", 5: "Lathe" };

router.get("/:orderNo/department-log/:dept", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const dept = parseInt(req.params.dept, 10);
    const config = DEPARTMENT_LOG_CONFIG[dept];
    if (!Number.isInteger(orderNo) || !config) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or department" });
    }

    try {
        const pool = await getSqlPool("proj");
        const result = await pool.request()
            .input("orderNo", orderNo)
            .query(`SELECT * FROM dbo.[${config.table}] WHERE orderno = @orderNo`);
        const row = result.recordset[0] || null;

        res.json({
            success: true,
            department: DEPARTMENT_NAMES[dept],
            entry: row
                ? {
                    checkboxes: config.checkboxCols.map((c) => row[c] === -1 || row[c] === "-1"),
                    values: config.valueCols.map((c) => row[c]),
                    date: row[config.dateCol],
                    note: config.hasNote ? row.Note : undefined,
                    orederPlace: config.hasNote ? row.OrederPlace : undefined,
                    place1: config.hasNote ? row.Place1 : undefined,
                    place2: config.hasNote ? row.Place2 : undefined,
                }
                : null,
        });
    } catch (err) {
        console.error("❌ PROJ DEPARTMENT LOG ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch department log" });
    }
});

router.post("/:orderNo/department-log/:dept", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const dept = parseInt(req.params.dept, 10);
    const config = DEPARTMENT_LOG_CONFIG[dept];
    if (!Number.isInteger(orderNo) || !config) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or department" });
    }
    const { checkboxes, values, date, note, orederPlace, place1, place2 } = req.body;

    try {
        const pool = await getSqlPool("proj");

        const orderResult = await pool.request()
            .input("orderNo", orderNo)
            .query("SELECT projNo, ProdctionNO FROM dbo.orders WHERE orderNo = @orderNo");
        const order = orderResult.recordset[0];
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const request = pool.request().input("orderNo", orderNo);
        const setClauses = [];
        const insertCols = ["orderno"];
        const insertVals = ["@orderNo"];

        config.checkboxCols.forEach((col, i) => {
            const checked = Array.isArray(checkboxes) && checkboxes[i];
            const val = config.checkboxIsString ? (checked ? "-1" : "0") : (checked ? -1 : 0);
            request.input(`cb${i}`, val);
            setClauses.push(`[${col}] = @cb${i}`);
            insertCols.push(`[${col}]`);
            insertVals.push(`@cb${i}`);
        });
        config.valueCols.forEach((col, i) => {
            const raw = Array.isArray(values) ? values[i] : undefined;
            const val = raw !== undefined && raw !== null && raw !== "" ? Number.parseFloat(raw) : null;
            request.input(`val${i}`, val);
            setClauses.push(`[${col}] = @val${i}`);
            insertCols.push(`[${col}]`);
            insertVals.push(`@val${i}`);
        });
        request.input("date", date || null);
        setClauses.push(`[${config.dateCol}] = @date`);
        insertCols.push(`[${config.dateCol}]`);
        insertVals.push("@date");
        // The extra "xN3" datetime field is always identical to the
        // completion date on every populated row sampled — mirrored here
        // rather than left null, to match that observed convention.
        setClauses.push(`[${config.extraDateCol}] = @date`);
        insertCols.push(`[${config.extraDateCol}]`);
        insertVals.push("@date");

        if (config.hasNote) {
            request.input("note", note || null).input("orederPlace", orederPlace || null)
                .input("place1", place1 || null).input("place2", place2 || null);
            setClauses.push("Note = @note", "OrederPlace = @orederPlace", "Place1 = @place1", "Place2 = @place2");
            insertCols.push("Note", "OrederPlace", "Place1", "Place2");
            insertVals.push("@note", "@orederPlace", "@place1", "@place2");
        }
        if (config.hasProjLookup) {
            request.input("projNo", order.projNo).input("prodNo", order.ProdctionNO);
            setClauses.push("ProjNO = @projNo", "ProdNO = @prodNo");
            insertCols.push("ProjNO", "ProdNO");
            insertVals.push("@projNo", "@prodNo");
        }

        const existing = await pool.request()
            .input("orderNo", orderNo)
            .query(`SELECT orderno FROM dbo.[${config.table}] WHERE orderno = @orderNo`);

        if (existing.recordset[0]) {
            await request.query(`UPDATE dbo.[${config.table}] SET ${setClauses.join(", ")} WHERE orderno = @orderNo`);
        } else {
            await request.query(`INSERT INTO dbo.[${config.table}] (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")})`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROJ DEPARTMENT LOG UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update department log" });
    }
});

// --- Order check report (dbo.OrderCH) --------------------------------------
// Mirrors the legacy Access app's "OrderCH" report — the one item left as
// "Partial" in the original parity audit because its calculated fields
// (Expr1-4) were opaque generic names with no visible formula. Resolved by
// reading OrderCH directly: it's a real SQL Server VIEW, not an Access-only
// query, so OBJECT_DEFINITION gave the exact formula with no guessing.
// Expr1 = AVG(Process.Colcting) and Expr2 = AVG(Process.Cuting) across an
// order's Process rows — real, usable completion fractions (0-1) for
// "collecting %" and "cutting %". Expr3 is just SUM(Process.Cuting), mostly
// redundant with Expr2 — not surfaced. Expr4 is a genuine legacy bug, not
// used here: its formula is
// "IIf(sum([Dx]) = -1, 1 - 1 - 2020, orders.DateFinsh)" — [Dx] isn't a real
// column (dbo.details has D1-D15, not "Dx"), and "1 - 1 - 2020" is
// arithmetic (evaluates to -2020), which SQL Server implicitly casts to a
// datetime as day offset -2020 from the 1899-12-30 OLE epoch — confirmed
// live producing the nonsense date "1894-06-21" for a real order (#322647)
// instead of its actual finish date. dbo.orders.dateFinsh (already used
// elsewhere in this file) is used directly instead — same data, no bug.
// turnaroundDays (DATEDIFF(day, oderDate, dateFinsh)) and avgTurnaroundDays
// below are a genuinely new capability, not a legacy port — confirmed via
// OBJECT_DEFINITION that the legacy "average order->close turnaround"
// report this was long assumed to correspond to (QSendOrdersCR/CR2, backed
// by dbo.QSendOrdersC -> Q-sendP1/P2 -> Q-sendX1-X5) never actually
// computes a turnaround figure anywhere in its view chain: Expr1/Expr2
// there are the exact same cutting/collecting-% formula OrderCH already
// exposes (via the near-identical ProcessN vs Process table — confirmed
// same row count, 57316), Expr4-Expr9 are raw per-department completion
// dates already covered by the /department-log endpoints, and OrederPlace/
// Note are already surfaced by the D1 print report. No AVG/DATEDIFF
// appears anywhere in that whole view chain — the "turnaround" impression
// in the original audit came from the legacy report's visual layout
// (oderDate and dateFinsh printed side by side for a human to eyeball),
// not from a real computed field. This is the first time it's actually
// been calculated.
router.get("/order-check", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("proj");
        const whereClause = search ? "WHERE projNo LIKE @search OR projName LIKE @search" : "";

        const countRequest = pool.request();
        if (search) countRequest.input("search", `%${search}%`);
        const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.OrderCH ${whereClause}`);
        const total = countResult.recordset[0].total;

        const avgRequest = pool.request();
        if (search) avgRequest.input("search", `%${search}%`);
        const avgResult = await avgRequest.query(`
            SELECT AVG(CAST(DATEDIFF(day, oderDate, dateFinsh) AS float)) AS avgTurnaroundDays
            FROM dbo.OrderCH
            ${whereClause ? `${whereClause} AND` : "WHERE"} dateFinsh IS NOT NULL AND dateFinsh >= oderDate
        `);
        const avgTurnaroundDays = avgResult.recordset[0].avgTurnaroundDays;

        const listRequest = pool.request();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        if (search) listRequest.input("search", `%${search}%`);
        // LEFT JOIN dbo.x1 pulls in the Place/Note fields the legacy
        // QSendOrdersCR/CR2 dispatch-slip report showed alongside cutting/
        // collecting % — x1.Note/OrederPlace/Place1/Place2 already exist and
        // are already read/written by the /department-log endpoints above,
        // just never surfaced here. Time (also on OrderCH itself) is legacy
        // and effectively unused for current orders (checked live: no
        // non-null value anywhere in the live order-number range) — shown
        // only if present, not relied on as the print slip's real timestamp.
        const listResult = await listRequest.query(`
            SELECT
                OrderCH.orderNo, OrderCH.projNo, OrderCH.projName, OrderCH.projMgr,
                OrderCH.ProdctionNO, OrderCH.oderDate, OrderCH.dateFinsh,
                Expr2 AS cuttingPct, Expr1 AS collectingPct, CountOforderNo AS itemCount,
                OrderCH.Time AS time,
                CASE WHEN dateFinsh IS NOT NULL AND dateFinsh >= oderDate
                     THEN DATEDIFF(day, oderDate, dateFinsh) END AS turnaroundDays,
                x.Note AS note, x.OrederPlace AS orederPlace, x.Place1 AS place1, x.Place2 AS place2
            FROM dbo.OrderCH
            LEFT JOIN dbo.x1 x ON x.orderno = OrderCH.orderNo
            ${whereClause}
            ORDER BY orderNo DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, entries: listResult.recordset, total, page, pageSize, avgTurnaroundDays });
    } catch (err) {
        console.error("❌ PROJ ORDER CHECK ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order check report" });
    }
});

export default router;
