// backend/routes/glass.js
// Read/write API for the "Glass" fabrication-order system — previously only
// browsable through a separate MS Access front-end (Glass -2024.MDB) linked
// via pass-through queries to the same live SQL Server "Glass" database this
// module talks to directly. Confirmed from the Access app's Main Menu VBA
// that the live workflow is: Sorders (order header) -> Sorderdetails (glass
// item specs: dimensions/color/type/thickness/spacer/section/shape) ->
// SSTOCK (received-into-store quantities) -> billing. A separate
// orders/orderdetails/STOCK/thenewstore table set exists in the same
// database but is not reachable from any Main Menu button in the Access
// app — it's the pre-cutover archive (orderNo tops out around 314054),
// superseded by Sorders/Sorderdetails/SSTOCK (orderNo picks up around
// 323097+), intentionally not used here.
//
// Billing (price/price1/plusCost/pricingType/billNote columns on
// Sorderdetails, plus the SBill table) mirrors the Access app's
// CheckBill/Bill tables and its Check1/Check2 stored-proc pricing formulas
// — but those procs/tables only ever targeted the legacy orderdetails
// table (CheckBill's max orderNo is exactly orders' max orderNo, 314054)
// and were never updated after the cutover, so billing has been silently
// unavailable for every order placed since. These columns/table were added
// directly to the live Sorderdetails table (additive, nullable) so billing
// works for current orders going forward; CheckBill/Bill remain untouched
// as the historical record for pre-cutover orders.
import express from "express";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { pushFinishedUnitToMinStock } from "../utils/minStockSync.js";

const router = express.Router();
router.use(authenticateToken, authorizeRoles("shipping_manager", "admin"));

// Matches the Access VBA's ItemNOC sub (M1 module): barcode = 2-digit year +
// last 4 digits of orderNo + serialNo, all concatenated then stored as an
// int. Confirmed against real live rows (e.g. orderNo 323123/serialNo 3 ->
// barcode 2631233 = "26"+"3123"+"3"), which settled an internal
// contradiction: an earlier version of this function zero-padded serialNo
// to 4 digits — that not only didn't match those live rows, it also
// silently broke 100% of new item creation starting this year, since
// "26" + 8 more digits always exceeds SQL int's ~2.147B ceiling (confirmed
// live: "Arithmetic overflow error converting expression to data type
// int"). No padding keeps the number small enough, same as Proj's own
// barcode formula in projOrders.js.
function buildBarcode(orderNo, serialNo) {
    const yy = String(new Date().getFullYear()).slice(-2);
    const or1 = String(orderNo).slice(-4);
    return parseInt(`${yy}${or1}${serialNo}`, 10);
}

// GET /api/glass/orders?search=&page=&pageSize=
// Order list with per-order totals, mirroring the Access app's
// SendOrdersDetails dashboard (backed by the [Q-OrdersNew] view): total
// ordered qty vs. total received (SSTOCK.QTYIN) vs. count of lines not yet
// fully received.
router.get("/orders", async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
        const offset = (page - 1) * pageSize;
        const search = String(req.query.search || "").trim();

        const whereClause = search ? "WHERE (o.projName LIKE @search OR o.projNo LIKE @search OR o.JPO LIKE @search)" : "";

        const { total, rows } = await withSqlRetry("glass", async (pool) => {
            const countRequest = pool.request();
            if (search) countRequest.input("search", `%${search}%`);
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM Sorders o ${whereClause}`);

            const rowsRequest = pool.request();
            rowsRequest.input("offset", offset);
            rowsRequest.input("pageSize", pageSize);
            if (search) rowsRequest.input("search", `%${search}%`);
            const rowsResult = await rowsRequest.query(`
                SELECT
                    o.orderNo, o.projNo, o.projName, o.projMgr, o.oderDate, o.JPO, o.ProdctionNO,
                    ISNULL(lines.totalQty, 0) AS totalQty,
                    ISNULL(received.totalReceived, 0) AS totalReceived,
                    ISNULL(lines.lineCount, 0) AS lineCount
                FROM Sorders o
                LEFT JOIN (
                    SELECT orderNo, SUM(qty) AS totalQty, COUNT(*) AS lineCount
                    FROM Sorderdetails
                    GROUP BY orderNo
                ) lines ON lines.orderNo = o.orderNo
                LEFT JOIN (
                    SELECT OrderNo, SUM(QTYIN) AS totalReceived
                    FROM SSTOCK
                    GROUP BY OrderNo
                ) received ON received.OrderNo = o.orderNo
                ${whereClause}
                ORDER BY o.orderNo DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            return { total: countResult.recordset[0].total, rows: rowsResult.recordset };
        });

        res.json({ success: true, orders: rows, total, page, pageSize });
    } catch (err) {
        console.error("❌ GLASS ORDERS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch glass orders" });
    }
});

// POST /api/glass/orders — create a new order header (Sorders). orderNo is
// an identity column, same as MinStock's STOCKO.orderNo.
router.post("/orders", async (req, res) => {
    const { projNo, projName, projMgr, JPO, ProdctionNO } = req.body;
    if (!projNo) {
        return res.status(400).json({ success: false, message: "projNo is required" });
    }

    try {
        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("projNo", projNo)
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .input("JPO", JPO || null)
            .input("ProdctionNO", ProdctionNO || null)
            .query(`
                INSERT INTO Sorders (projNo, projName, projMgr, oderDate, JPO, ProdctionNO)
                OUTPUT INSERTED.orderNo
                VALUES (@projNo, @projName, @projMgr, GETDATE(), @JPO, @ProdctionNO)
            `));
        res.json({ success: true, orderNo: result.recordset[0].orderNo });
    } catch (err) {
        console.error("❌ GLASS CREATE ORDER ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create glass order" });
    }
});

// PUT /api/glass/orders/:orderNo — edit a small set of non-ledger fields.
// projNo is excluded: it groups /reports/status and /reports/billing
// totals, so reattributing an order after invoices exist would corrupt
// those reports. ProdctionNO is excluded: the receive handler reads it to
// gate the push into Main Stock (pushFinishedUnitToMinStock) — editing it
// mid-order, after some items already synced under the old value, would
// desync Main Stock's record of what production order a unit belongs to.
router.put("/orders/:orderNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { projName, projMgr, JPO } = req.body;

    try {
        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .input("JPO", JPO || null)
            .query(`
                UPDATE Sorders
                SET projName = @projName, projMgr = @projMgr, JPO = @JPO
                WHERE orderNo = @orderNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ GLASS UPDATE ORDER ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update glass order" });
    }
});

// GET /api/glass/orders/:orderNo/items — Sorderdetails lines for an order,
// joined with SSTOCK for received qty and a computed area in m^2 (matches
// the Access app's Round(height*width*qty/10000, 2) area expression used
// throughout its forms/reports/billing).
router.get("/orders/:orderNo/items", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT
                    d.orderNo, d.serialNo, d.itemNo, d.height, d.width, d.qty,
                    d.incolor, d.intype, d.inthickness, d.spacer,
                    d.outcolor, d.outtype, d.outthickness,
                    d.section, d.shape, d.note, d.expectdate, d.status, d.person, d.dept,
                    d.barcode, d.[financial notes] AS financialNotes,
                    Round((d.height * d.width * d.qty) / 10000, 2) AS area,
                    ISNULL(s.QTYIN, 0) AS receivedQty
                FROM Sorderdetails d
                LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                WHERE d.orderNo = @orderNo
                ORDER BY d.serialNo ASC
            `));

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ GLASS ORDER ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch glass order items" });
    }
});

// POST /api/glass/orders/:orderNo/items — add a glass item line (Sorderdetails)
router.post("/orders/:orderNo/items", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const {
        itemNo, height, width, qty,
        incolor, intype, inthickness, spacer,
        outcolor, outtype, outthickness,
        section, shape, note, expectdate, status, person, dept, financialNotes,
    } = req.body;
    if (!height || !width || !qty || parseFloat(qty) <= 0) {
        return res.status(400).json({ success: false, message: "height, width, and a positive qty are required" });
    }

    try {
        const result = await withSqlRetry("glass", async (pool) => {
            const transaction = pool.transaction();
            await transaction.begin();
            try {
                const orderResult = await transaction.request()
                    .input("orderNo", orderNo)
                    .query("SELECT orderNo FROM Sorders WHERE orderNo = @orderNo");
                if (!orderResult.recordset[0]) {
                    await transaction.rollback();
                    return { notFound: true };
                }

                const maxResult = await transaction.request()
                    .input("orderNo", orderNo)
                    .query("SELECT ISNULL(MAX(serialNo), 0) AS maxSerial FROM Sorderdetails WHERE orderNo = @orderNo");
                const serialNo = maxResult.recordset[0].maxSerial + 1;
                const barcode = buildBarcode(orderNo, serialNo);

                await transaction.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("itemNo", itemNo || null)
                    .input("height", parseFloat(height))
                    .input("width", parseFloat(width))
                    .input("qty", parseInt(qty))
                    .input("incolor", incolor || null)
                    .input("intype", intype || null)
                    .input("inthickness", inthickness ? parseFloat(inthickness) : null)
                    .input("spacer", spacer || null)
                    .input("outcolor", outcolor || null)
                    .input("outtype", outtype || null)
                    .input("outthickness", outthickness || null)
                    .input("section", section || null)
                    .input("shape", shape || null)
                    .input("note", note || null)
                    .input("expectdate", expectdate || null)
                    .input("status", status || null)
                    .input("person", person || null)
                    .input("dept", dept || null)
                    .input("barcode", barcode)
                    .input("financialNotes", financialNotes || null)
                    .query(`
                        INSERT INTO Sorderdetails
                            (orderNo, serialNo, itemNo, height, width, qty, incolor, intype, inthickness, spacer,
                             outcolor, outtype, outthickness, section, shape, note, expectdate, status, person, dept, barcode, [financial notes])
                        VALUES
                            (@orderNo, @serialNo, @itemNo, @height, @width, @qty, @incolor, @intype, @inthickness, @spacer,
                             @outcolor, @outtype, @outthickness, @section, @shape, @note, @expectdate, @status, @person, @dept, @barcode, @financialNotes)
                    `);

                await transaction.commit();
                return { serialNo, barcode };
            } catch (err) {
                try { await transaction.rollback(); } catch { /* already rolled back */ }
                throw err;
            }
        });

        if (result.notFound) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true, serialNo: result.serialNo, barcode: result.barcode });
    } catch (err) {
        console.error("❌ GLASS CREATE ITEM ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create glass item" });
    }
});

// PUT /api/glass/orders/:orderNo/items/:serialNo — edit a small set of
// non-billing, non-quantity fields. height/width/qty excluded per policy.
// intype/outtype/spacer are ALSO excluded even though they look like plain
// color/type selections: computeBilling() below reads them directly —
// intype/outtype drive frostedCost, spacer indexes the PU/SG/SCHOCO rate
// tables into totalPU — so they're billing-calculation inputs, not free
// descriptive text. expectdate is excluded too: it gates /reports/overdue
// and /not-received's bucketing, so editing it after the fact could hide
// or manufacture an overdue item.
//
// financialNotes ([financial notes]) added: a plain descriptive note column
// that was previously readable via GET /orders/:orderNo/items but had no
// write path at all — not in this whitelist, not even in the POST create
// INSERT — making it settable only by direct DB edit despite the API
// returning it. Safe to whitelist: free text, not read by computeBilling()
// or any report-bucketing logic.
router.put("/orders/:orderNo/items/:serialNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    const serialNo = parseInt(req.params.serialNo);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const {
        itemNo, incolor, inthickness, outcolor, outthickness,
        section, shape, note, status, person, dept, financialNotes,
    } = req.body;

    try {
        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("itemNo", itemNo || null)
            .input("incolor", incolor || null)
            .input("inthickness", inthickness ? parseFloat(inthickness) : null)
            .input("outcolor", outcolor || null)
            .input("outthickness", outthickness || null)
            .input("section", section || null)
            .input("shape", shape || null)
            .input("note", note || null)
            .input("status", status || null)
            .input("person", person || null)
            .input("dept", dept || null)
            .input("financialNotes", financialNotes || null)
            .query(`
                UPDATE Sorderdetails
                SET itemNo = @itemNo, incolor = @incolor, inthickness = @inthickness,
                    outcolor = @outcolor, outthickness = @outthickness, section = @section,
                    shape = @shape, note = @note, status = @status, person = @person, dept = @dept,
                    [financial notes] = @financialNotes
                WHERE orderNo = @orderNo AND serialNo = @serialNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Item not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ GLASS UPDATE ITEM ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update glass item" });
    }
});

// POST /api/glass/orders/:orderNo/items/:serialNo/receive — mark a produced
// item as received into store. The Access app does this in two steps
// (StmpStock staging insert -> SStockUP proc copies into SSTOCK for sticker
// printing), then lets the user hand-type QTYIN into the SSTOCK datasheet
// grid directly. This collapses that into one call: upsert the SSTOCK row
// and set QTYIN directly, since the staging table only ever existed to
// batch sticker printing, not to gate the receive itself.
// Once received, a glass item is pushed into Main Stock (category 2,
// already the established "Glass (legacy)" tag on mainStockCategories.ts)
// so it becomes shippable through the existing Ship Multiple Items screen
// — Glass does not get its own ship-out UI; Main Stock is the single
// store+ship control point across departments. The push reuses this same
// item's own barcode (see minStockSync.js) rather than generating a new
// one, so re-scanning the physical sticker already on the glass item
// resolves straight to its Main Stock row — the mobile scan screen tries
// Main Stock before Glass on every scan, so this is what actually routes
// a received item into the ship flow. Best-effort: a failure here doesn't
// fail the receive itself (the SQL Server write to Glass's own DB already
// committed), just logs, since the two databases can't share a
// transaction.
router.post("/orders/:orderNo/items/:serialNo/receive", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    const serialNo = parseInt(req.params.serialNo);
    const { store, qty } = req.body;
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const qtyIn = parseInt(qty);
    if (!Number.isInteger(qtyIn) || qtyIn <= 0) {
        return res.status(400).json({ success: false, message: "A positive qty is required" });
    }

    try {
        // withSqlRetry reruns this whole block on a transient failure, which
        // re-reads QTYIN before re-applying it — safe for the ordinary
        // "never reached the server" timeout this guards against, but if a
        // write ever committed server-side right as the connection dropped
        // (ack lost, not just the request), a retry would double-count this
        // receive. Accepted as the same narrow trade-off already made for
        // mainStock.js/projOrders.js's own withSqlRetry usage — connection
        // failures observed here are consistently pre-connect timeouts, not
        // mid-query drops.
        const { item, totalQtyIn } = await withSqlRetry("glass", async (pool) => {
            const itemResult = await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .query(`
                    SELECT d.barcode, d.itemNo, d.height, d.width, d.outcolor,
                           o.projNo, o.projName, o.projMgr, o.ProdctionNO
                    FROM Sorderdetails d
                    JOIN Sorders o ON o.orderNo = d.orderNo
                    WHERE d.orderNo = @orderNo AND d.serialNo = @serialNo
                `);
            const item = itemResult.recordset[0];
            if (!item) return { item: null, totalQtyIn: 0 };

            let totalQtyIn = qtyIn;
            const existing = await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .query("SELECT QTYIN FROM SSTOCK WHERE OrderNo = @orderNo AND SerialNo = @serialNo");

            if (existing.recordset[0]) {
                totalQtyIn = existing.recordset[0].QTYIN + qtyIn;
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("qtyIn", totalQtyIn)
                    .query("UPDATE SSTOCK SET QTYIN = @qtyIn WHERE OrderNo = @orderNo AND SerialNo = @serialNo");
            } else {
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("barcode", item.barcode)
                    .input("store", store ? parseInt(store) : null)
                    .input("qtyIn", qtyIn)
                    .query(`
                        INSERT INTO SSTOCK (STORE, BARCODE, ORDER_DATE, QTYIN, OrderNo, SerialNo)
                        VALUES (@store, @barcode, GETDATE(), @qtyIn, @orderNo, @serialNo)
                    `);
            }

            return { item, totalQtyIn };
        });

        if (!item) {
            return res.status(404).json({ success: false, message: "Item not found in this order" });
        }

        if (item.projNo && item.ProdctionNO) {
            try {
                await pushFinishedUnitToMinStock({
                    projNo: item.projNo,
                    projName: item.projName,
                    ProdctionNO: item.ProdctionNO,
                    projMgr: item.projMgr,
                    category: 2,
                    sourceKey: `GLASS:${orderNo}:${serialNo}`,
                    description: [item.itemNo, item.height && item.width ? `${item.height}x${item.width}` : null, item.outcolor]
                        .filter(Boolean).join(" "),
                    qty: totalQtyIn,
                    unitNo: item.barcode || serialNo,
                    barcode: item.barcode || undefined,
                });
            } catch (syncErr) {
                console.error("⚠️ GLASS -> MIN STOCK SYNC FAILED (receive still succeeded):", syncErr);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ GLASS RECEIVE ITEM ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to receive glass item" });
    }
});

// GET/PUT /api/glass/orders/:orderNo/appointments — appointment scheduling
// and delay tracking against the external Ittihad fabrication factory.
// Confirmed live and genuinely active (not legacy cruft): the underlying
// [Dat Orders] table had 78 rows written in the 30 days before this was
// built, newest dated the day of the audit. One row per order (confirmed:
// zero orderNo values have more than one row), reached in the legacy app
// from a popup off SendOrdersDetails1 — no equivalent existed anywhere in
// the web app before this.
//
// Fields, confirmed via the legacy form's own control labels (COM
// inspection, not guessed): datOrder = date an appointment/delivery slot
// was secured; dat1/dat2/dat3 = up to three scheduled appointment dates
// (reschedule history); finshed1/finshed2 = fabrication work start/end at
// the factory; taken = date the finished glass was picked up; qut/qutIN/
// qutun/totalQut = quantity completed/received/under-work/total; brcode =
// a plain reference barcode (not a real FK, same as elsewhere in this
// schema); Notic = notes.
//
// Deliberately NOT ported: the legacy form's own three computed duration
// fields (Text45/47/49, "Supply/Delivery/Delay duration") depend on two
// helper fields (Text41/Text43) that aren't captioned or resolvable from
// the VBA alone — replicating that formula blind risked shipping a
// confidently-wrong number. Instead this computes one clearly-defined,
// unambiguous metric server-side: turnaroundDays = taken - datOrder.
router.get("/orders/:orderNo/appointments", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT orderNo, projNo, ProdctionNO, datOrder, dat1, dat2, dat3,
                       finshed1, finshed2, taken, totalQut, qut, qutIN, qutun, brcode, Notic,
                       CASE WHEN taken IS NOT NULL AND datOrder IS NOT NULL AND taken >= datOrder
                            THEN DATEDIFF(day, datOrder, taken) END AS turnaroundDays
                FROM [Dat Orders]
                WHERE orderNo = @orderNo
            `));

        res.json({ success: true, appointment: result.recordset[0] || null });
    } catch (err) {
        console.error("❌ GLASS APPOINTMENTS GET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch appointment tracking" });
    }
});

router.put("/orders/:orderNo/appointments", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }
        const {
            datOrder, dat1, dat2, dat3, finshed1, finshed2, taken,
            totalQut, qut, qutIN, qutun, brcode, notic,
        } = req.body;

        const order = await withSqlRetry("glass", async (pool) => {
            const orderResult = await pool.request()
                .input("orderNo", orderNo)
                .query("SELECT orderNo, projNo, projName, projMgr, ProdctionNO FROM Sorders WHERE orderNo = @orderNo");
            const order = orderResult.recordset[0];
            if (!order) return null;

            const existing = await pool.request()
                .input("orderNo", orderNo)
                .query("SELECT orderNo FROM [Dat Orders] WHERE orderNo = @orderNo");

            const request = pool.request()
                .input("orderNo", orderNo)
                .input("projNo", order.projNo || null)
                .input("ProdctionNO", order.ProdctionNO || null)
                .input("datOrder", datOrder || null)
                .input("dat1", dat1 || null)
                .input("dat2", dat2 || null)
                .input("dat3", dat3 || null)
                .input("finshed1", finshed1 || null)
                .input("finshed2", finshed2 || null)
                .input("taken", taken || null)
                .input("totalQut", totalQut !== undefined && totalQut !== null && totalQut !== "" ? parseInt(totalQut, 10) : null)
                .input("qut", qut !== undefined && qut !== null && qut !== "" ? parseInt(qut, 10) : null)
                .input("qutIN", qutIN !== undefined && qutIN !== null && qutIN !== "" ? parseInt(qutIN, 10) : null)
                .input("qutun", qutun !== undefined && qutun !== null && qutun !== "" ? parseInt(qutun, 10) : null)
                .input("brcode", brcode !== undefined && brcode !== null && brcode !== "" ? parseInt(brcode, 10) : null)
                .input("notic", notic || null);

            if (existing.recordset[0]) {
                await request.query(`
                    UPDATE [Dat Orders]
                    SET projNo = @projNo, ProdctionNO = @ProdctionNO, datOrder = @datOrder,
                        dat1 = @dat1, dat2 = @dat2, dat3 = @dat3, finshed1 = @finshed1, finshed2 = @finshed2,
                        taken = @taken, totalQut = @totalQut, qut = @qut, qutIN = @qutIN, qutun = @qutun,
                        brcode = @brcode, Notic = @notic
                    WHERE orderNo = @orderNo
                `);
            } else {
                await request.query(`
                    INSERT INTO [Dat Orders]
                        (orderNo, projNo, ProdctionNO, datOrder, dat1, dat2, dat3, finshed1, finshed2,
                         taken, totalQut, qut, qutIN, qutun, brcode, Notic)
                    VALUES
                        (@orderNo, @projNo, @ProdctionNO, @datOrder, @dat1, @dat2, @dat3, @finshed1, @finshed2,
                         @taken, @totalQut, @qut, @qutIN, @qutun, @brcode, @notic)
                `);
            }

            return order;
        });

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Factory-finished (finshed2 set) means the glass is ready to ship
        // directly from the glass store, without waiting for a separate
        // manual per-item receive first -- auto-run the same receive +
        // Main-Stock-push logic /items/:serialNo/receive already uses, for
        // every item on this order not yet fully received. Idempotent (only
        // touches items where receivedQty < qty), so calling this endpoint
        // again later (e.g. just editing Notic) is a safe no-op for items
        // already pushed. Best-effort per item, same trade-off as the manual
        // receive handler: a Main Stock sync failure here must not fail the
        // appointment save itself, since [Dat Orders] already committed.
        if (finshed2 && order.projNo && order.ProdctionNO) {
            try {
                const itemsResult = await withSqlRetry("glass", (pool) => pool.request()
                    .input("orderNo", orderNo)
                    .query(`
                        SELECT d.serialNo, d.barcode, d.itemNo, d.height, d.width, d.qty, d.outcolor,
                               ISNULL(s.QTYIN, 0) AS receivedQty
                        FROM Sorderdetails d
                        LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                        WHERE d.orderNo = @orderNo
                    `));
                const pending = itemsResult.recordset.filter((it) => it.receivedQty < (it.qty || 0));

                for (const item of pending) {
                    try {
                        await withSqlRetry("glass", async (pool) => {
                            const existing = await pool.request()
                                .input("orderNo", orderNo)
                                .input("serialNo", item.serialNo)
                                .query("SELECT QTYIN FROM SSTOCK WHERE OrderNo = @orderNo AND SerialNo = @serialNo");
                            if (existing.recordset[0]) {
                                await pool.request()
                                    .input("orderNo", orderNo)
                                    .input("serialNo", item.serialNo)
                                    .input("qtyIn", item.qty)
                                    .query("UPDATE SSTOCK SET QTYIN = @qtyIn WHERE OrderNo = @orderNo AND SerialNo = @serialNo");
                            } else {
                                await pool.request()
                                    .input("orderNo", orderNo)
                                    .input("serialNo", item.serialNo)
                                    .input("barcode", item.barcode)
                                    .input("qtyIn", item.qty)
                                    .query(`
                                        INSERT INTO SSTOCK (BARCODE, ORDER_DATE, QTYIN, OrderNo, SerialNo)
                                        VALUES (@barcode, GETDATE(), @qtyIn, @orderNo, @serialNo)
                                    `);
                            }
                        });

                        await pushFinishedUnitToMinStock({
                            projNo: order.projNo,
                            projName: order.projName,
                            ProdctionNO: order.ProdctionNO,
                            projMgr: order.projMgr,
                            category: 2,
                            sourceKey: `GLASS:${orderNo}:${item.serialNo}`,
                            description: [item.itemNo, item.height && item.width ? `${item.height}x${item.width}` : null, item.outcolor]
                                .filter(Boolean).join(" "),
                            qty: item.qty,
                            unitNo: item.barcode || item.serialNo,
                            barcode: item.barcode || undefined,
                        });
                    } catch (itemErr) {
                        console.error(`⚠️ GLASS AUTO-RECEIVE FAILED for item ${orderNo}:${item.serialNo} (appointment save still succeeded):`, itemErr);
                    }
                }
            } catch (syncErr) {
                console.error("⚠️ GLASS AUTO-RECEIVE (factory-finished) FAILED (appointment save still succeeded):", syncErr);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ GLASS APPOINTMENTS SAVE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to save appointment tracking" });
    }
});

// GET /api/glass/ready-to-ship?orderNo= — items received into store but not
// yet (fully) shipped out to their project, the glass-side mirror of
// /not-received (which tracks factory -> store instead of store -> project).
// GlassOut currently has no writer anywhere in this app — the POST
// .../ship endpoint that used to write it was removed (confirmed dead, zero
// frontend caller; real glass ship-out flows through Min Stock's own
// STOCKO/Stock/out chain via minStockSync.js instead, see glass.js's
// receive handler). shippedQty below will always compute as 0 until/unless
// something writes to GlassOut again — this report still correctly shows
// "received but not synced-out yet" in the meantime.
router.get("/ready-to-ship", async (req, res) => {
    try {
        const orderNo = req.query.orderNo ? parseInt(req.query.orderNo) : null;

        const result = await withSqlRetry("glass", (pool) => {
            const request = pool.request();
            let whereClause = "";
            if (orderNo !== null) {
                request.input("orderNo", orderNo);
                whereClause = "AND d.orderNo = @orderNo";
            }

            return request.query(`
                SELECT
                    d.orderNo, d.serialNo, d.itemNo, d.height, d.width, d.qty, d.barcode,
                    o.projNo, o.projName, o.projMgr,
                    s.QTYIN AS receivedQty,
                    ISNULL(g.shippedQty, 0) AS shippedQty,
                    s.QTYIN - ISNULL(g.shippedQty, 0) AS remainingToShip
                FROM Sorderdetails d
                JOIN Sorders o ON o.orderNo = d.orderNo
                JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                LEFT JOIN (
                    SELECT OrderNo, SerialNo, SUM(qty) AS shippedQty
                    FROM GlassOut
                    GROUP BY OrderNo, SerialNo
                ) g ON g.OrderNo = d.orderNo AND g.SerialNo = d.serialNo
                WHERE s.QTYIN > 0 AND s.QTYIN - ISNULL(g.shippedQty, 0) > 0 ${whereClause}
                ORDER BY d.orderNo DESC, d.serialNo ASC
            `);
        });

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ GLASS READY-TO-SHIP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch ready-to-ship items" });
    }
});

// GET /api/glass/not-received?orderNo= — items ordered but not yet (fully)
// received into store, matching the Access app's notRecItem/notRec reports.
router.get("/not-received", async (req, res) => {
    try {
        const orderNo = req.query.orderNo ? parseInt(req.query.orderNo) : null;

        const result = await withSqlRetry("glass", (pool) => {
            const request = pool.request();
            let whereClause = "";
            if (orderNo !== null) {
                request.input("orderNo", orderNo);
                whereClause = "AND d.orderNo = @orderNo";
            }

            return request.query(`
                SELECT
                    d.orderNo, d.serialNo, d.itemNo, d.height, d.width, d.qty, d.barcode,
                    d.expectdate, d.status, o.projNo, o.projName, o.projMgr,
                    ISNULL(s.QTYIN, 0) AS receivedQty
                FROM Sorderdetails d
                JOIN Sorders o ON o.orderNo = d.orderNo
                LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                WHERE ISNULL(s.QTYIN, 0) < d.qty ${whereClause}
                ORDER BY d.orderNo DESC, d.serialNo ASC
            `);
        });

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ GLASS NOT RECEIVED ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch not-received items" });
    }
});

// GET /api/glass/barcode/:barcode — look up a single glass item by its
// barcode, for the mobile scan workflow (mirrors the Access app's barcode
// form recordsource in M1's barcodeC sub).
router.get("/barcode/:barcode", async (req, res) => {
    try {
        const barcode = parseInt(req.params.barcode);
        if (!Number.isInteger(barcode)) {
            return res.status(400).json({ success: false, message: "Invalid barcode" });
        }

        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("barcode", barcode)
            .query(`
                SELECT
                    o.projNo, o.projName, o.orderNo, d.serialNo, d.section, d.shape, d.spacer,
                    d.height, d.width, d.itemNo, d.qty, d.barcode, d.incolor, d.intype, d.inthickness,
                    d.outcolor, d.outtype, d.outthickness, o.JPO, o.ProdctionNO,
                    d.note, d.status, d.person, d.dept, d.expectdate,
                    ISNULL(s.QTYIN, 0) AS receivedQty,
                    ISNULL(g.shippedQty, 0) AS shippedQty,
                    ISNULL(s.QTYIN, 0) - ISNULL(g.shippedQty, 0) AS remainingToShip
                FROM Sorderdetails d
                JOIN Sorders o ON o.orderNo = d.orderNo
                LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                LEFT JOIN (
                    SELECT OrderNo, SerialNo, SUM(qty) AS shippedQty
                    FROM GlassOut
                    GROUP BY OrderNo, SerialNo
                ) g ON g.OrderNo = d.orderNo AND g.SerialNo = d.serialNo
                WHERE d.barcode = @barcode
            `));

        if (!result.recordset[0]) {
            return res.status(404).json({ success: false, message: "No item found for this barcode" });
        }
        res.json({ success: true, item: result.recordset[0] });
    } catch (err) {
        console.error("❌ GLASS BARCODE LOOKUP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to look up barcode" });
    }
});

// GET /api/glass/items?search=&onlyNotReceived=false — cross-order item
// search, matching the Access app's itemsQAll/itemsQAllA browse grids.
router.get("/items", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const onlyNotReceived = req.query.onlyNotReceived === "true";

        const result = await withSqlRetry("glass", (pool) => {
            const request = pool.request();
            const conditions = [];
            if (search) {
                request.input("search", `%${search}%`);
                conditions.push("(o.projName LIKE @search OR o.projNo LIKE @search OR d.itemNo LIKE @search)");
            }
            if (onlyNotReceived) {
                conditions.push("ISNULL(s.QTYIN, 0) < d.qty");
            }
            const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

            return request.query(`
                SELECT
                    d.orderNo, d.serialNo, d.itemNo, d.height, d.width, d.qty, d.barcode,
                    d.incolor, d.intype, d.inthickness, d.spacer, d.outcolor, d.outtype, d.outthickness,
                    d.section, d.shape, d.status, d.expectdate,
                    o.projNo, o.projName, o.projMgr,
                    ISNULL(s.QTYIN, 0) AS receivedQty
                FROM Sorderdetails d
                JOIN Sorders o ON o.orderNo = d.orderNo
                LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                ${whereClause}
                ORDER BY d.orderNo DESC, d.serialNo ASC
            `);
        });

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ GLASS ITEMS SEARCH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to search glass items" });
    }
});

// Per-unit-area/per-qty spacer rates for the two gas-fill types, and the
// perimeter-spacer type — transcribed exactly from the Access app's Check1
// stored procedure (dbo.Check1). Each type picks its area-based rate when
// the single-unit area (height*width/10000) is >= 0.8 m^2, otherwise a
// flat per-piece rate.
const PU_AREA_RATE = { "6": 5.75, "8": 6.2, "10": 6.65, "12": 7.1, "14": 7.45, "16": 7.8 };
const PU_QTY_RATE = { "6": 4.6, "8": 4.96, "10": 5.32, "12": 5.68, "14": 5.96, "16": 6.24 };
const SG_AREA_RATE = { "6": 6.45, "8": 6.75, "10": 7.2, "12": 7.6, "14": 8.1, "16": 8.6 };
const SG_QTY_RATE = { "6": 5.16, "8": 5.4, "10": 5.76, "12": 6.08, "14": 6.48, "16": 6.88 };
const SCHOCO_AREA_RATE = { "15": 9.45, "20": 12 };
const SCHOCO_QTY_RATE = { "15": 9, "20": 9.6 };

const round3 = (n) => Math.round(n * 1000) / 1000;

// Computes the same derived billing fields as Check1, given a Sorderdetails
// row (height/width/qty/spacer/intype/outtype plus the billing input
// columns price/price1/plusCost/pricingType).
function computeBilling(row) {
    const height = row.height || 0;
    const width = row.width || 0;
    const qty = row.qty || 0;
    const price = row.price || 0;
    const price1 = row.price1 || 0;
    const plusCost = row.plusCost || 0;
    const spacer = row.spacer || "";
    const pricingType = row.pricingType || "";

    const arya = round3((height * width * qty) / 10000);
    const arya00 = round3((height * width) / 10000);
    const cost = round3(price * arya);
    const cost1 = round3(price1 * arya);
    const frostedCost = round3(
        (row.intype === "Frosted" ? arya * 5 : 0) + (row.outtype === "Frosted" ? arya * 5 : 0)
    );

    const puCost = pricingType === "PU"
        ? round3(arya00 >= 0.8 ? (PU_AREA_RATE[spacer] || 0) * arya : (PU_QTY_RATE[spacer] || 0) * qty)
        : 0;
    const sgCost = pricingType === "SG"
        ? round3(arya00 >= 0.8 ? (SG_AREA_RATE[spacer] || 0) * arya : (SG_QTY_RATE[spacer] || 0) * qty)
        : 0;
    // Matches Check1 exactly — the schuco branch checks the *total* area
    // (arya), not the single-unit area (arya00) that PU/SG check.
    const shocoCost = pricingType === "schuco"
        ? round3(arya >= 0.8 ? (SCHOCO_AREA_RATE[spacer] || 0) * arya : (SCHOCO_QTY_RATE[spacer] || 0) * qty)
        : 0;

    const totalPU = price > 0 ? round3(shocoCost + puCost + sgCost + plusCost + frostedCost + cost1 + cost) : 0;

    return { arya, arya00, cost, cost1, frostedCost, puCost, sgCost, shocoCost, totalPU };
}

// GET /api/glass/orders/:orderNo/billing — items with computed pricing.
router.get("/orders/:orderNo/billing", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT orderNo, serialNo, itemNo, height, width, qty, spacer, intype, outtype,
                       price, price1, plusCost, pricingType, billNote, barcode
                FROM Sorderdetails
                WHERE orderNo = @orderNo
                ORDER BY serialNo ASC
            `));

        const items = result.recordset.map(row => ({ ...row, ...computeBilling(row) }));
        const orderTotal = round3(items.reduce((sum, it) => sum + it.totalPU, 0));

        res.json({ success: true, items, orderTotal });
    } catch (err) {
        console.error("❌ GLASS BILLING ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch billing" });
    }
});

// PUT /api/glass/orders/:orderNo/items/:serialNo/billing — set the billing
// inputs for one line (everything else is derived, not stored).
router.put("/orders/:orderNo/items/:serialNo/billing", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    const serialNo = parseInt(req.params.serialNo);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const { price, price1, plusCost, pricingType, billNote } = req.body;
    if (pricingType && !["UP", "PU", "SG", "schuco"].includes(pricingType)) {
        return res.status(400).json({ success: false, message: "pricingType must be one of UP, PU, SG, schuco" });
    }

    try {
        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("price", price != null ? parseFloat(price) : null)
            .input("price1", price1 != null ? parseFloat(price1) : null)
            .input("plusCost", plusCost != null ? parseFloat(plusCost) : null)
            .input("pricingType", pricingType || null)
            .input("billNote", billNote || null)
            .query(`
                UPDATE Sorderdetails
                SET price = @price, price1 = @price1, plusCost = @plusCost,
                    pricingType = @pricingType, billNote = @billNote
                WHERE orderNo = @orderNo AND serialNo = @serialNo
            `));
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: "Item not found in this order" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ GLASS UPDATE BILLING ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update billing" });
    }
});

// GET /api/glass/orders/:orderNo/bills — invoice records for an order
// (mirrors the Access app's Bill table/form).
router.get("/orders/:orderNo/bills", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT ID, orderNo, BillNO, Price, DateBill, Note, DateEnter
                FROM SBill
                WHERE orderNo = @orderNo
                ORDER BY DateEnter DESC
            `));
        res.json({ success: true, bills: result.recordset });
    } catch (err) {
        console.error("❌ GLASS BILLS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch bills" });
    }
});

// POST /api/glass/orders/:orderNo/bills — record a new invoice for an order.
router.post("/orders/:orderNo/bills", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { BillNO, Price, DateBill, Note } = req.body;
    if (Price == null || parseFloat(Price) <= 0) {
        return res.status(400).json({ success: false, message: "A positive Price is required" });
    }

    try {
        const result = await withSqlRetry("glass", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("BillNO", BillNO ? parseInt(BillNO) : null)
            .input("Price", parseFloat(Price))
            .input("DateBill", DateBill || null)
            .input("Note", Note || null)
            .query(`
                INSERT INTO SBill (orderNo, BillNO, Price, DateBill, Note, DateEnter)
                OUTPUT INSERTED.ID
                VALUES (@orderNo, @BillNO, @Price, @DateBill, @Note, GETDATE())
            `));
        res.json({ success: true, id: result.recordset[0].ID });
    } catch (err) {
        console.error("❌ GLASS CREATE BILL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create bill" });
    }
});

// GET /api/glass/reports/status?dateFrom=&dateTo=&projNo= — per-order
// received-vs-ordered breakdown, for a production-status overview.
router.get("/reports/status", async (req, res) => {
    try {
        const { dateFrom, dateTo, projNo } = req.query;
        const result = await withSqlRetry("glass", (pool) => {
            const request = pool.request();
            const conditions = [];
            if (dateFrom) { request.input("dateFrom", dateFrom); conditions.push("o.oderDate >= @dateFrom"); }
            if (dateTo) { request.input("dateTo", dateTo); conditions.push("o.oderDate <= @dateTo"); }
            if (projNo) { request.input("projNo", `%${projNo}%`); conditions.push("o.projNo LIKE @projNo"); }
            const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

            return request.query(`
                SELECT
                    o.orderNo, o.projNo, o.projName, o.projMgr, o.oderDate,
                    ISNULL(lines.totalQty, 0) AS totalQty,
                    ISNULL(received.totalReceived, 0) AS totalReceived,
                    ISNULL(lines.lineCount, 0) AS lineCount,
                    ISNULL(fullyReceived.cnt, 0) AS fullyReceivedLines
                FROM Sorders o
                LEFT JOIN (
                    SELECT orderNo, SUM(qty) AS totalQty, COUNT(*) AS lineCount
                    FROM Sorderdetails GROUP BY orderNo
                ) lines ON lines.orderNo = o.orderNo
                LEFT JOIN (
                    SELECT OrderNo, SUM(QTYIN) AS totalReceived
                    FROM SSTOCK GROUP BY OrderNo
                ) received ON received.OrderNo = o.orderNo
                LEFT JOIN (
                    SELECT d.orderNo, COUNT(*) AS cnt
                    FROM Sorderdetails d
                    LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
                    WHERE ISNULL(s.QTYIN, 0) >= d.qty
                    GROUP BY d.orderNo
                ) fullyReceived ON fullyReceived.orderNo = o.orderNo
                ${whereClause}
                ORDER BY o.orderNo DESC
            `);
        });

        const orders = result.recordset.map(row => ({
            ...row,
            pctReceived: row.totalQty > 0 ? Math.round((row.totalReceived / row.totalQty) * 100) : 0,
        }));

        const totals = orders.reduce((acc, o) => ({
            totalQty: acc.totalQty + o.totalQty,
            totalReceived: acc.totalReceived + o.totalReceived,
            orderCount: acc.orderCount + 1,
            fullyReceivedOrders: acc.fullyReceivedOrders + (o.lineCount > 0 && o.fullyReceivedLines >= o.lineCount ? 1 : 0),
        }), { totalQty: 0, totalReceived: 0, orderCount: 0, fullyReceivedOrders: 0 });

        res.json({ success: true, orders, totals });
    } catch (err) {
        console.error("❌ GLASS STATUS REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch status report" });
    }
});

// GET /api/glass/reports/billing?dateFrom=&dateTo=&projNo= — computed
// (priced-but-maybe-not-yet-invoiced) totals vs. actually invoiced (SBill)
// totals, grouped by project, so outstanding-to-invoice stands out.
router.get("/reports/billing", async (req, res) => {
    try {
        const { dateFrom, dateTo, projNo } = req.query;
        const { itemsResult, billsResult } = await withSqlRetry("glass", async (pool) => {
            const itemsRequest = pool.request();
            const itemConditions = ["d.price IS NOT NULL"];
            if (dateFrom) { itemsRequest.input("dateFrom", dateFrom); itemConditions.push("o.oderDate >= @dateFrom"); }
            if (dateTo) { itemsRequest.input("dateTo", dateTo); itemConditions.push("o.oderDate <= @dateTo"); }
            if (projNo) { itemsRequest.input("projNo", `%${projNo}%`); itemConditions.push("o.projNo LIKE @projNo"); }
            const itemsResult = await itemsRequest.query(`
                SELECT o.orderNo, o.projNo, o.projName,
                       d.height, d.width, d.qty, d.spacer, d.intype, d.outtype,
                       d.price, d.price1, d.plusCost, d.pricingType
                FROM Sorderdetails d
                JOIN Sorders o ON o.orderNo = d.orderNo
                WHERE ${itemConditions.join(" AND ")}
            `);

            const billsRequest = pool.request();
            const billConditions = [];
            if (dateFrom) { billsRequest.input("dateFrom", dateFrom); billConditions.push("b.DateEnter >= @dateFrom"); }
            if (dateTo) { billsRequest.input("dateTo", dateTo); billConditions.push("b.DateEnter <= @dateTo"); }
            if (projNo) { billsRequest.input("projNo", `%${projNo}%`); billConditions.push("o.projNo LIKE @projNo"); }
            const billsWhereClause = billConditions.length ? `WHERE ${billConditions.join(" AND ")}` : "";
            const billsResult = await billsRequest.query(`
                SELECT o.projNo, o.projName, SUM(b.Price) AS invoicedTotal, COUNT(*) AS billCount
                FROM SBill b
                JOIN Sorders o ON o.orderNo = b.orderNo
                ${billsWhereClause}
                GROUP BY o.projNo, o.projName
            `);

            return { itemsResult, billsResult };
        });

        const byProject = new Map();
        itemsResult.recordset.forEach(row => {
            const key = row.projNo;
            const { totalPU } = computeBilling(row);
            const entry = byProject.get(key) || { projNo: row.projNo, projName: row.projName, computedTotal: 0, invoicedTotal: 0, billCount: 0 };
            entry.computedTotal = round3(entry.computedTotal + totalPU);
            byProject.set(key, entry);
        });
        billsResult.recordset.forEach(row => {
            const key = row.projNo;
            const entry = byProject.get(key) || { projNo: row.projNo, projName: row.projName, computedTotal: 0, invoicedTotal: 0, billCount: 0 };
            entry.invoicedTotal = round3(row.invoicedTotal || 0);
            entry.billCount = row.billCount;
            byProject.set(key, entry);
        });

        const projects = Array.from(byProject.values())
            .map(p => ({ ...p, outstanding: round3(p.computedTotal - p.invoicedTotal) }))
            .sort((a, b) => b.computedTotal - a.computedTotal);

        const totals = projects.reduce((acc, p) => ({
            computedTotal: round3(acc.computedTotal + p.computedTotal),
            invoicedTotal: round3(acc.invoicedTotal + p.invoicedTotal),
            outstanding: round3(acc.outstanding + p.outstanding),
        }), { computedTotal: 0, invoicedTotal: 0, outstanding: 0 });

        res.json({ success: true, projects, totals });
    } catch (err) {
        console.error("❌ GLASS BILLING REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch billing report" });
    }
});

// GET /api/glass/reports/overdue — items past their expected date and not
// yet fully received.
router.get("/reports/overdue", async (req, res) => {
    try {
        const result = await withSqlRetry("glass", (pool) => pool.request().query(`
            SELECT
                d.orderNo, d.serialNo, d.itemNo, d.qty, d.expectdate, d.barcode,
                o.projNo, o.projName, o.projMgr,
                ISNULL(s.QTYIN, 0) AS receivedQty,
                DATEDIFF(day, d.expectdate, GETDATE()) AS daysOverdue
            FROM Sorderdetails d
            JOIN Sorders o ON o.orderNo = d.orderNo
            LEFT JOIN SSTOCK s ON s.OrderNo = d.orderNo AND s.SerialNo = d.serialNo
            WHERE d.expectdate IS NOT NULL
              AND d.expectdate < GETDATE()
              AND ISNULL(s.QTYIN, 0) < d.qty
            ORDER BY d.expectdate ASC
        `));
        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ GLASS OVERDUE REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch overdue report" });
    }
});

// GET /api/glass/reports/factory-status?dateFrom=&dateTo=&projNo= — every
// current order bucketed by where it stands at the external Ittihad
// factory, the aggregate view legacy Access's UnderWork/LateDate/NoDate/
// FINSH reports gave (this app's own /orders/:orderNo/appointments is
// per-order only). [Dat Orders] has no single "the appointment date"
// column — datOrder is when a slot was secured, dat1/dat2/dat3 are
// reschedule history — so COALESCE(dat3, dat2, dat1, datOrder) (most
// recently set wins) is the best available "current expected date" for
// the late-bucket check. Confirmed live against the real table: 42 rows
// across its full history have finshed1 set without finshed2, so
// underWork is a real, if small, bucket rather than dead code.
//
// finshed2 (not taken) is "Finished" -- all items done at the external
// Ittihad factory, per the factory's own form ("completion end date").
// taken is a distinct, later step -- the glass physically reserved into
// our own store ("receipt date") -- kept as its own bucket rather than
// folded into "finished" so the two real states aren't conflated. See
// PUT .../appointments below: setting finshed2 now also auto-pushes
// every not-yet-received item on the order into Main Stock, so
// "Finished" items are actually shippable (directly from the glass
// store) the moment this bucket applies, not only after someone
// separately marks them taken.
router.get("/reports/factory-status", async (req, res) => {
    try {
        const { dateFrom, dateTo, projNo } = req.query;
        const result = await withSqlRetry("glass", (pool) => {
            const request = pool.request();
            const conditions = [];
            if (dateFrom) { request.input("dateFrom", dateFrom); conditions.push("o.oderDate >= @dateFrom"); }
            if (dateTo) { request.input("dateTo", dateTo); conditions.push("o.oderDate <= @dateTo"); }
            if (projNo) { request.input("projNo", `%${projNo}%`); conditions.push("o.projNo LIKE @projNo"); }
            const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

            return request.query(`
                SELECT
                    o.orderNo, o.projNo, o.projName, o.projMgr, o.oderDate,
                    d.datOrder, d.dat1, d.dat2, d.dat3, d.finshed1, d.finshed2, d.taken,
                    CASE
                        WHEN d.orderNo IS NULL OR (d.datOrder IS NULL AND d.dat1 IS NULL AND d.dat2 IS NULL AND d.dat3 IS NULL) THEN 'noDate'
                        WHEN d.taken IS NOT NULL THEN 'taken'
                        WHEN d.finshed2 IS NOT NULL THEN 'finished'
                        WHEN d.finshed1 IS NOT NULL THEN 'underWork'
                        WHEN COALESCE(d.dat3, d.dat2, d.dat1, d.datOrder) < CAST(GETDATE() AS date) THEN 'late'
                        ELSE 'onTrack'
                    END AS bucket
                FROM Sorders o
                LEFT JOIN [Dat Orders] d ON d.orderNo = o.orderNo
                ${whereClause}
                ORDER BY o.orderNo DESC
            `);
        });

        const orders = result.recordset;
        const totals = orders.reduce((acc, o) => {
            acc[o.bucket] = (acc[o.bucket] || 0) + 1;
            return acc;
        }, { noDate: 0, late: 0, underWork: 0, finished: 0, taken: 0, onTrack: 0 });

        res.json({ success: true, orders, totals });
    } catch (err) {
        console.error("❌ GLASS FACTORY STATUS REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch factory status report" });
    }
});

// GET /api/glass/reports/store?projNo= — the webapp equivalent of the
// legacy Access app's storeQ/STORENEW forms: everything currently sitting
// in the physical glass store, not yet shipped out. Reads Main Stock's own
// STOCKO/Stock tables (category C=2, the Glass tag) rather than
// reconstructing the legacy storenew/thenewstore chain -- confirmed via
// the live SQL Server view definitions (Server.storenew1Query etc.) that
// the legacy "in store" quantity is exactly QTYIN minus what's been
// shipped, which is precisely what Stock.SQTY (QTY - QTYOUT, kept in sync
// from [out] by minStockSync.js/mainStock.js's own checkout endpoints)
// already represents for anything pushed here. Since finshed2 now
// auto-pushes finished items into Main Stock (see PUT .../appointments
// above) and Main Stock's own Ship Multiple Items screen already captures
// a driver name on shipment (mirroring thenewstore's driver-dispatch
// log), this single dashboard replaces the legacy storeQ -> STORENEW ->
// thenewstore flow end to end.
//
// --- Backfill history (2026-07-21) ---
// This endpoint only shows items pushed to Main Stock going forward (via
// the finshed2 auto-receive above) -- orders finished before that code
// existed were never pushed, so a one-time backfill was run to catch up
// the backlog. Naively backfilling every [Dat Orders] row with finshed2
// set (6,892 live-range rows) would have been wrong: the vast majority of
// those were already received into SSTOCK *and* already shipped out
// historically via the legacy thenewstore ledger, long before this
// report existed. Backfilling from finshed2 alone would have
// re-surfaced already-shipped glass as "available to ship" here.
// Instead, the backfill queried Server.storenew1Query directly -- the
// legacy app's own trusted "QTYIN minus already-shipped" calculation --
// restricted to the live order range (orderNo >= 323097), which found
// the real, much smaller scope: 16 line items across 12 orders / 10
// projects, 19 units total genuinely still in the glass store. Each was
// pushed via pushFinishedUnitToMinStock with qty = the view's own
// remaining-quantity figure (not the full original QTYIN), so any
// partial shipment already logged historically was correctly excluded.
// Verified live afterward: report showed Projects=10, In Store=19,
// matching the backfill exactly.
router.get("/reports/store", async (req, res) => {
    try {
        const { projNo } = req.query;
        const result = await withSqlRetry("minstock", (pool) => {
            const request = pool.request();
            let whereClause = "";
            if (projNo) {
                request.input("projNo", `%${projNo}%`);
                whereClause = "AND s.projNo LIKE @projNo";
            }
            return request.query(`
                SELECT
                    s.orderNo AS minStockOrderNo, s.projNo, s.projName, s.ProdctionNO,
                    k.serialNo, k.Prodc AS description, k.UNO, k.barcode,
                    k.QTY AS qty, k.QTYOUT AS shippedQty, k.SQTY AS remainingQty, k.Date AS date
                FROM STOCKO s
                JOIN Stock k ON k.orderNo = s.orderNo
                WHERE s.C = 2 AND k.SQTY > 0 ${whereClause}
                ORDER BY s.projName, k.Date DESC
            `);
        });

        const items = result.recordset;
        const projectMap = new Map();
        for (const item of items) {
            const key = item.projNo;
            if (!projectMap.has(key)) {
                projectMap.set(key, { projNo: item.projNo, projName: item.projName, remainingQty: 0, lineCount: 0 });
            }
            const entry = projectMap.get(key);
            entry.remainingQty += item.remainingQty;
            entry.lineCount += 1;
        }

        res.json({ success: true, items, projectTotals: Array.from(projectMap.values()) });
    } catch (err) {
        console.error("❌ GLASS STORE REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch glass store report" });
    }
});

export default router;
