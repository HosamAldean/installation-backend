// backend/routes/iron.js
// Iron/steel department order tracking — previously only creatable through
// a dedicated legacy MS Access front-end ("Iron& - Final_Backup_Backup.mdb"),
// confirmed live and still actively used today (newest ordersI row at the
// time this was built was dated two days prior). This had ZERO web-app
// presence before this file — no SQL Server connection pool key, no route,
// no page — despite ordersI/orderdetailsI/ProcessI each holding 6,000-15,000
// live rows.
//
// Confirmed live: this app's own tables are a near-exact structural clone of
// the "Proj" app's schema (orders/orderdetails/D1/x1/Process), just
// suffixed "I" for Iron, living on its own separate SQL Server database
// ("Iron", same PETRA-SQL\ACCESPROJ instance as proj/stockhouse/glass/
// minstock — see getSqlPool('iron') in config/db.js). The legacy app's own
// Main Menu caption calls it "برنامج الاعمال المتبادلة بين الاقسام"
// ("interdepartmental work-exchange program") — orders here represent work
// handed to the Iron/steel workshop from other departments, not sales
// orders. Field-level differences from Proj were all confirmed live (not
// assumed from the Proj pattern) via Design-view COM inspection of the
// actual Iron forms:
//   - ordersI has no Color/Time/SUser/SDate columns Proj's orders does.
//   - orderdetailsI has no free-text [1]/[2] columns; instead structured
//     dimenisons/quntity/color/referenceI/referenceM/Location/PrudactS
//     fields, each with a real on-screen Arabic label (confirmed via COM,
//     not guessed): dimenisons="القياس" (measurement), quntity="العدد"
//     (count), referenceI="رقم مرجع المحددة" (reference # for the
//     "specified/designated" item — meaning unconfirmed beyond that),
//     referenceM="رقم مرجع مكس" (a "Mix" reference # — likely cross-refs
//     Stock House's MIX/coating system, but that link isn't built here;
//     exposed as a plain opaque field like Cut.Saction was for Proj).
//   - orderdetailsI.barcode exists but is NOT reliably populated (confirmed
//     live: only 1,811 of 14,953 rows are non-zero, with no evident
//     generation pattern on the populated ones) — unlike Proj/Glass, this
//     doesn't invent a barcode formula; it's a plain optional int.
//   - D1I (notes) has no Action/ActionDate columns — just Ditails/
//     DitalsDate, a flatter event log than Proj's D1. D1I is the
//     dominant/active variant (its siblings D1I1-4 have 1/11/3/0 rows
//     respectively, same "one real table, rest are unused near-duplicates"
//     pattern as Proj's D2-D5) so only D1I is used here.
//   - X1I (event log) is structurally identical to Proj's x1 (xc1-3
//     checkboxes, x1/x2 generic-labeled value fields, a completion date) —
//     same generic "x1"/"x2" Label captions confirmed live, so exposed the
//     same way. CORRECTED from an earlier assumption: unlike D1I/D2-D5
//     (genuinely one real table plus unused near-duplicates), X1I1-4 here
//     ARE a real department dimension, same idea as Proj's x1-x5 — each is
//     a distinct department's own inquiry screen off the Main Menu (MIX/
//     specified-works/lathe/factory, see the event-log route below for the
//     verified button-caption mapping), and 52% of orders present in both
//     X1I and X1I2 have a genuinely different completion date between
//     them. All five tables are read/written by department. See PUT/GET
//     .../event-log for the full detail.
//   - ProcessI (per-item cutting/prep status) confirmed as real Access
//     checkboxes (0/1, not the -1/0 OLE convention seen elsewhere) for
//     Cuting ("القص" — cutting) and Colcting ("التجهيز" — preparation, not
//     literally "collecting" despite the field name) plus a completion
//     date. One row per orderdetailsI line (composite orderNo+serialNo key,
//     not identity), so this upserts like Proj's own `details` table did.
//   - PrudactS and Location are real lookup tables (5 and 3 values
//     respectively, confirmed live), not free text.
import express from "express";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { pushFinishedUnitToMinStock } from "../utils/minStockSync.js";

const router = express.Router();

// No dedicated "Iron/steel department" role exists in the current taxonomy
// (same situation Proj's order-intake routes were in) — gated to
// installation_manager/admin for now; revisit if that turns out wrong.
router.use(authenticateToken, authorizeRoles("installation_manager", "admin"));

async function resolveUsername(req) {
    const user = await User.findByPk(req.user.userId, { attributes: ["username"] });
    return user?.username || String(req.user.userId);
}

// GET /api/iron?search=&page=&pageSize=
router.get("/", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const whereClause = search ? "WHERE o.projNo LIKE @search OR o.projName LIKE @search" : "";

        const { total, rows } = await withSqlRetry("iron", async (pool) => {
            const countRequest = pool.request();
            if (search) countRequest.input("search", `%${search}%`);
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.ordersI o ${whereClause}`);

            const rowsRequest = pool.request();
            rowsRequest.input("offset", offset).input("pageSize", pageSize);
            if (search) rowsRequest.input("search", `%${search}%`);
            const rowsResult = await rowsRequest.query(`
                SELECT
                    o.orderNo, o.projNo, o.projName, o.projMgr, o.oderDate,
                    o.ProdctionNO, o.ProdctionDate, o.dateFinsh,
                    ISNULL(lines.lineCount, 0) AS lineCount
                FROM dbo.ordersI o
                LEFT JOIN (
                    SELECT orderNo, COUNT(*) AS lineCount
                    FROM dbo.orderdetailsI
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
        console.error("❌ IRON ORDERS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch orders" });
    }
});

// POST /api/iron — create a new order header (dbo.ordersI). orderNo is a
// SQL Server IDENTITY column — never supplied by the caller.
router.post("/", async (req, res) => {
    const { projNo, projName, projMgr, ProdctionNO, ProdctionDate } = req.body;
    if (!projNo || !String(projNo).trim()) {
        return res.status(400).json({ success: false, message: "projNo is required" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("projNo", String(projNo).trim())
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .input("ProdctionNO", ProdctionNO || null)
            .input("ProdctionDate", ProdctionDate || null)
            .query(`
                INSERT INTO dbo.ordersI (projNo, projName, projMgr, oderDate, ProdctionNO, ProdctionDate)
                OUTPUT INSERTED.orderNo
                VALUES (@projNo, @projName, @projMgr, GETDATE(), @ProdctionNO, @ProdctionDate)
            `));
        res.status(201).json({ success: true, orderNo: result.recordset[0].orderNo });
    } catch (err) {
        console.error("❌ IRON ORDER CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create order" });
    }
});

// PUT /api/iron/:orderNo — edit an order header. Previously this whole
// module was create-only, meaning a typo could only be fixed through the
// still-live legacy Access app, risking silent divergence between the two.
router.put("/:orderNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { projNo, projName, projMgr, ProdctionNO, ProdctionDate } = req.body;
    if (!projNo || !String(projNo).trim()) {
        return res.status(400).json({ success: false, message: "projNo is required" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("projNo", String(projNo).trim())
            .input("projName", projName || null)
            .input("projMgr", projMgr || null)
            .input("ProdctionNO", ProdctionNO || null)
            .input("ProdctionDate", ProdctionDate || null)
            .query(`
                UPDATE dbo.ordersI
                SET projNo = @projNo, projName = @projName, projMgr = @projMgr,
                    ProdctionNO = @ProdctionNO, ProdctionDate = @ProdctionDate
                WHERE orderNo = @orderNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON ORDER UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order" });
    }
});

// GET /api/iron/lookups — PrudactS (responsible section) and Location
// (post-prep work location) dropdown options, confirmed real lookup tables
// live (5 and 3 rows respectively), not free text.
router.get("/lookups", async (req, res) => {
    try {
        const { prudactS, location } = await withSqlRetry("iron", async (pool) => ({
            prudactS: await pool.request().query("SELECT PrudactS FROM dbo.PrudactS WHERE PrudactS <> '0' ORDER BY ID"),
            location: await pool.request().query("SELECT Location FROM dbo.Location WHERE Location <> '0' ORDER BY ID"),
        }));
        res.json({
            success: true,
            prudactS: prudactS.recordset.map((r) => r.PrudactS),
            locations: location.recordset.map((r) => r.Location),
        });
    } catch (err) {
        console.error("❌ IRON LOOKUPS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch lookups" });
    }
});

// GET /api/iron/:orderNo/items
router.get("/:orderNo/items", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo, 10);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT orderNo, serialNo, itemNo, Prudact, dimenisons, quntity, color, note,
                       referenceI, referenceM, barcode, Location, PrudactS
                FROM dbo.orderdetailsI
                WHERE orderNo = @orderNo
                ORDER BY serialNo ASC
            `));

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ IRON ORDER ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order items" });
    }
});

// POST /api/iron/:orderNo/items — add an order line (dbo.orderdetailsI).
// No barcode auto-generation — confirmed live this field isn't reliably
// populated even in the legacy app (see file header), so it's accepted as
// a plain optional value rather than invented.
router.post("/:orderNo/items", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { itemNo, Prudact, dimenisons, quntity, color, note, referenceI, referenceM, location, prudactS, barcode } = req.body;

    try {
        const result = await withSqlRetry("iron", async (pool) => {
            const transaction = pool.transaction();
            await transaction.begin();
            try {
                const orderResult = await transaction.request()
                    .input("orderNo", orderNo)
                    .query("SELECT orderNo FROM dbo.ordersI WHERE orderNo = @orderNo");
                if (!orderResult.recordset[0]) {
                    await transaction.rollback();
                    return { notFound: true };
                }

                const maxResult = await transaction.request()
                    .input("orderNo", orderNo)
                    .query("SELECT ISNULL(MAX(serialNo), 0) AS maxSerial FROM dbo.orderdetailsI WHERE orderNo = @orderNo");
                const serialNo = maxResult.recordset[0].maxSerial + 1;

                await transaction.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("itemNo", itemNo || null)
                    .input("Prudact", Prudact || null)
                    .input("dimenisons", dimenisons || null)
                    .input("quntity", quntity !== undefined && quntity !== null && quntity !== "" ? parseInt(quntity, 10) : null)
                    .input("color", color || null)
                    .input("note", note || null)
                    .input("referenceI", referenceI || null)
                    .input("referenceM", referenceM || null)
                    .input("location", location || null)
                    .input("prudactS", prudactS || null)
                    .input("barcode", barcode !== undefined && barcode !== null && barcode !== "" ? parseInt(barcode, 10) : null)
                    .query(`
                        INSERT INTO dbo.orderdetailsI
                            (orderNo, serialNo, itemNo, Prudact, dimenisons, quntity, color, note,
                             referenceI, referenceM, Location, PrudactS, barcode)
                        VALUES
                            (@orderNo, @serialNo, @itemNo, @Prudact, @dimenisons, @quntity, @color, @note,
                             @referenceI, @referenceM, @location, @prudactS, @barcode)
                    `);

                await transaction.commit();
                return { serialNo };
            } catch (err) {
                try { await transaction.rollback(); } catch { /* already rolled back */ }
                throw err;
            }
        });

        if (result.notFound) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(201).json({ success: true, serialNo: result.serialNo });
    } catch (err) {
        console.error("❌ IRON ORDER ITEM CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create order item" });
    }
});

// PUT /api/iron/:orderNo/items/:serialNo — edit an order line. Same
// composite-key upsert target as ProcessI, but this is the orderdetailsI
// row itself (specs/qty/references), not the cutting/prep status.
router.put("/:orderNo/items/:serialNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const { itemNo, Prudact, dimenisons, quntity, color, note, referenceI, referenceM, location, prudactS, barcode } = req.body;

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .input("itemNo", itemNo || null)
            .input("Prudact", Prudact || null)
            .input("dimenisons", dimenisons || null)
            .input("quntity", quntity !== undefined && quntity !== null && quntity !== "" ? parseInt(quntity, 10) : null)
            .input("color", color || null)
            .input("note", note || null)
            .input("referenceI", referenceI || null)
            .input("referenceM", referenceM || null)
            .input("location", location || null)
            .input("prudactS", prudactS || null)
            .input("barcode", barcode !== undefined && barcode !== null && barcode !== "" ? parseInt(barcode, 10) : null)
            .query(`
                UPDATE dbo.orderdetailsI
                SET itemNo = @itemNo, Prudact = @Prudact, dimenisons = @dimenisons, quntity = @quntity,
                    color = @color, note = @note, referenceI = @referenceI, referenceM = @referenceM,
                    Location = @location, PrudactS = @prudactS, barcode = @barcode
                WHERE orderNo = @orderNo AND serialNo = @serialNo
            `));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Item not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON ORDER ITEM UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order item" });
    }
});

// DELETE /api/iron/:orderNo/items/:serialNo — also removes the item's
// ProcessI row (composite orderNo+serialNo key, same as orderdetailsI) so a
// delete doesn't leave an orphaned cutting/prep-status row behind.
router.delete("/:orderNo/items/:serialNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }

    try {
        const notFound = await withSqlRetry("iron", async (pool) => {
            const transaction = pool.transaction();
            await transaction.begin();
            try {
                await transaction.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .query("DELETE FROM dbo.ProcessI WHERE orderNo = @orderNo AND serialNo = @serialNo");

                const result = await transaction.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .query("DELETE FROM dbo.orderdetailsI WHERE orderNo = @orderNo AND serialNo = @serialNo");

                if (!result.rowsAffected[0]) {
                    await transaction.rollback();
                    return true;
                }

                await transaction.commit();
                return false;
            } catch (err) {
                try { await transaction.rollback(); } catch { /* already rolled back */ }
                throw err;
            }
        });

        if (notFound) {
            return res.status(404).json({ success: false, message: "Item not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON ORDER ITEM DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete order item" });
    }
});

// --- Order notes (dbo.D1I) --------------------------------------------
// Confirmed live: D1I is the real, actively-used notes table — its
// siblings D1I1-4 have 1/11/3/0 rows respectively, same "one dominant
// table, rest near-unused duplicates" pattern Proj's D1 vs D2-D5 had.
// Flatter than Proj's D1 — no Action/ActionDate resolve-tracking columns,
// just a straight event log. ID is a real identity column.
router.get("/:orderNo/notes", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo, 10);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }

        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT ID, Ditails, DitalsDate
                FROM dbo.D1I
                WHERE orderno = @orderNo
                ORDER BY ID DESC
            `));

        res.json({ success: true, notes: result.recordset });
    } catch (err) {
        console.error("❌ IRON ORDER NOTES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order notes" });
    }
});

router.post("/:orderNo/notes", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { ditails } = req.body;
    if (!ditails || !String(ditails).trim()) {
        return res.status(400).json({ success: false, message: "ditails is required" });
    }

    try {
        const result = await withSqlRetry("iron", async (pool) => {
            const orderResult = await pool.request()
                .input("orderNo", orderNo)
                .query("SELECT orderNo FROM dbo.ordersI WHERE orderNo = @orderNo");
            if (!orderResult.recordset[0]) return null;

            return pool.request()
                .input("orderNo", orderNo)
                .input("ditails", String(ditails).trim())
                .query(`
                    INSERT INTO dbo.D1I (orderno, Ditails, DitalsDate)
                    OUTPUT INSERTED.ID
                    VALUES (@orderNo, @ditails, GETDATE())
                `);
        });

        if (!result) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(201).json({ success: true, id: result.recordset[0].ID });
    } catch (err) {
        console.error("❌ IRON ORDER NOTE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to add order note" });
    }
});

router.put("/:orderNo/notes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const { ditails } = req.body;
    if (!ditails || !String(ditails).trim()) {
        return res.status(400).json({ success: false, message: "ditails is required" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("id", id)
            .input("ditails", String(ditails).trim())
            .query("UPDATE dbo.D1I SET Ditails = @ditails WHERE ID = @id"));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Note not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON ORDER NOTE UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order note" });
    }
});

router.delete("/:orderNo/notes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, message: "Invalid id" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request().input("id", id).query("DELETE FROM dbo.D1I WHERE ID = @id"));
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Note not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON ORDER NOTE DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete order note" });
    }
});

// --- Per-item cutting/prep status (dbo.ProcessI) ---------------------------
// Confirmed live: real Access checkboxes (0/1), not the -1/0 OLE convention
// seen elsewhere in this codebase — Cuting ("القص" — cutting) and Colcting
// ("التجهيز" — preparation, despite the field name reading like
// "collecting"). One row per orderdetailsI line (composite orderNo+serialNo
// key, not identity), so this upserts like Proj's own `details` table.
router.get("/:orderNo/items/:serialNo/process", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .input("serialNo", serialNo)
            .query("SELECT Cuting, Colcting, DateI, finaldate FROM dbo.ProcessI WHERE orderNo = @orderNo AND serialNo = @serialNo"));
        const row = result.recordset[0] || null;

        res.json({
            success: true,
            status: {
                cuting: row ? row.Cuting === 1 : false,
                colcting: row ? row.Colcting === 1 : false,
                date: row ? row.DateI : null,
                finalDate: row ? row.finaldate : null,
            },
        });
    } catch (err) {
        console.error("❌ IRON PROCESS STATUS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch item process status" });
    }
});

// Once both Cutting and Preparation are marked done, the item is finished
// and pushed into Main Stock (category 3, the existing "Steel/Wood" tag on
// mainStockCategories.ts) so it becomes shippable through the existing Ship
// Multiple Items screen — Iron does not get its own ship-out UI; Main
// Stock is the single store+ship control point across departments.
// Best-effort: a failure here doesn't fail the status update itself (the
// SQL Server write to Iron's own DB already committed), just logs, since
// the two databases can't share a transaction.
router.post("/:orderNo/items/:serialNo/process", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    const { cuting, colcting, date } = req.body;
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }

    try {
        const cutingVal = cuting ? 1 : 0;
        const colctingVal = colcting ? 1 : 0;

        // Fully idempotent (sets absolute values, no increment) so safe to
        // retry the whole existing-check + update-or-insert as one block.
        await withSqlRetry("iron", async (pool) => {
            const existing = await pool.request()
                .input("orderNo", orderNo)
                .input("serialNo", serialNo)
                .query("SELECT orderNo FROM dbo.ProcessI WHERE orderNo = @orderNo AND serialNo = @serialNo");

            if (existing.recordset[0]) {
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("cuting", cutingVal)
                    .input("colcting", colctingVal)
                    .input("date", date || null)
                    .query("UPDATE dbo.ProcessI SET Cuting = @cuting, Colcting = @colcting, DateI = @date WHERE orderNo = @orderNo AND serialNo = @serialNo");
            } else {
                await pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .input("cuting", cutingVal)
                    .input("colcting", colctingVal)
                    .input("date", date || null)
                    .query("INSERT INTO dbo.ProcessI (orderNo, serialNo, Cuting, Colcting, DateI) VALUES (@orderNo, @serialNo, @cuting, @colcting, @date)");
            }
        });

        if (cutingVal === 1 && colctingVal === 1) {
            try {
                const detail = await withSqlRetry("iron", (pool) => pool.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .query(`
                        SELECT d.itemNo, d.Prudact, d.quntity, d.barcode,
                               o.projNo, o.projName, o.projMgr, o.ProdctionNO
                        FROM dbo.orderdetailsI d
                        JOIN dbo.ordersI o ON o.orderNo = d.orderNo
                        WHERE d.orderNo = @orderNo AND d.serialNo = @serialNo
                    `));
                const row = detail.recordset[0];
                if (row && row.projNo && row.ProdctionNO) {
                    await pushFinishedUnitToMinStock({
                        projNo: row.projNo,
                        projName: row.projName,
                        ProdctionNO: row.ProdctionNO,
                        projMgr: row.projMgr,
                        category: 3,
                        sourceKey: `IRON:${orderNo}:${serialNo}`,
                        description: [row.itemNo, row.Prudact].filter(Boolean).join(" "),
                        qty: row.quntity || 1,
                        unitNo: row.barcode || serialNo,
                    });
                }
            } catch (syncErr) {
                console.error("⚠️ IRON -> MIN STOCK SYNC FAILED (status update still succeeded):", syncErr);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON PROCESS STATUS UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update item process status" });
    }
});

// --- Order event log (dbo.X1I + department siblings X1I1-4) ---------------
// Corrected from an earlier assumption: X1I1-4 are NOT near-unused
// duplicates of X1I. Confirmed live via the Main Menu's own button
// captions (COM-inspected, not guessed) that each is a distinct
// department's inquiry screen — Command1="الاستفسار عن التبادلات الانتاج"
// (production exchanges, X1I), Command41="...تبادلات MIX" (MIX, X1I1),
// Command42="...اعمال المحددة" (specified/designated works, X1I2),
// Command43="...اعمال المخرطة" (lathe/turning work, X1I3), Command44=
// "...المصنع" (factory, X1I4) — and confirmed live that this isn't
// redundant tracking: of the ~3,362 orders present in both X1I and X1I2,
// 52% have a genuinely different x3 completion date between the two
// tables. Reading/writing only X1I (as this endpoint used to) means the
// app is blind to — or edits the wrong record for — any order whose real
// status lives in a department table instead. xc4/xc5 exist on all five
// tables but are confirmed entirely unused (0 non-zero rows across all
// five, live) — not exposed here, matching the legacy form which never
// shows them either.
const IRON_EVENT_LOG_DEPARTMENTS = {
    production: "X1I",
    mix: "X1I1",
    specifiedWorks: "X1I2",
    lathe: "X1I3",
    factory: "X1I4",
};

router.get("/:orderNo/event-log", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }

    try {
        const entries = await withSqlRetry("iron", async (pool) => {
            const result = {};
            for (const [key, table] of Object.entries(IRON_EVENT_LOG_DEPARTMENTS)) {
                const r = await pool.request()
                    .input("orderNo", orderNo)
                    .query(`SELECT xc1, xc2, xc3, x1, x2, date FROM dbo.${table} WHERE orderno = @orderNo`);
                const row = r.recordset[0];
                result[key] = row
                    ? {
                        checkboxes: [row.xc1, row.xc2, row.xc3].map((v) => v === "-1"),
                        values: [row.x1, row.x2],
                        date: row.date,
                    }
                    : null;
            }
            return result;
        });

        res.json({ success: true, entries });
    } catch (err) {
        console.error("❌ IRON EVENT LOG ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch order event log" });
    }
});

router.post("/:orderNo/event-log", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { checkboxes, values, date } = req.body;
    const department = IRON_EVENT_LOG_DEPARTMENTS[req.body.department] ? req.body.department : "production";
    const table = IRON_EVENT_LOG_DEPARTMENTS[department];

    try {
        const cb = [0, 1, 2].map((i) => (Array.isArray(checkboxes) && checkboxes[i] ? "-1" : "0"));
        const val = [0, 1].map((i) => {
            const raw = Array.isArray(values) ? values[i] : undefined;
            return raw !== undefined && raw !== null && raw !== "" ? Number.parseFloat(raw) : null;
        });

        const orderFound = await withSqlRetry("iron", async (pool) => {
            const orderResult = await pool.request()
                .input("orderNo", orderNo)
                .query("SELECT orderNo FROM dbo.ordersI WHERE orderNo = @orderNo");
            if (!orderResult.recordset[0]) return false;

            const existing = await pool.request()
                .input("orderNo", orderNo)
                .query(`SELECT orderno FROM dbo.${table} WHERE orderno = @orderNo`);

            const request = pool.request()
                .input("orderNo", orderNo)
                .input("xc1", cb[0]).input("xc2", cb[1]).input("xc3", cb[2])
                .input("x1", val[0]).input("x2", val[1])
                .input("date", date || null);

            if (existing.recordset[0]) {
                await request.query(`UPDATE dbo.${table} SET xc1=@xc1, xc2=@xc2, xc3=@xc3, x1=@x1, x2=@x2, x3=@date, date=@date WHERE orderno = @orderNo`);
            } else {
                await request.query(`INSERT INTO dbo.${table} (orderno, xc1, xc2, xc3, x1, x2, x3, date) VALUES (@orderNo, @xc1, @xc2, @xc3, @x1, @x2, @date, @date)`);
            }
            return true;
        });

        if (!orderFound) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ IRON EVENT LOG UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update order event log" });
    }
});

// --- Reporting layer (guest.SendOrdersCI) -----------------------------
// Legacy app's "SendordersI" form/report — confirmed live as a real SQL
// Server view (guest.SendOrdersCI, in the "guest" schema like Stock House's
// Reservation/ReReservation2 tables, not "dbo"), read directly via
// OBJECT_DEFINITION rather than guessed:
//   SELECT PrudactS, orderNo, projNo, projName, projMgr, COUNT(orderNo) AS CountOforderNo,
//          oderDate, ProdctionNO,
//          SUM(Colcting)/COUNT(Colcting) AS Expr1,   -- collecting % (0-1)
//          SUM(Cuting)/COUNT(Cuting) AS Expr2,        -- cutting % (0-1)
//          SUM(Cuting*quntity) AS Expr3,              -- qty actually cut
//          SUM(quntity) AS SumOfquntity                -- qty in this order+section
//   FROM ordersI LEFT JOIN noRecItemI ON ...
//   GROUP BY PrudactS, orderNo, projNo, projName, projMgr, oderDate, ProdctionNO
// One row per (order, PrudactS/section) — matches the legacy report's own
// grouping, not aggregated further. Unlike Proj's OrderCH, Expr1/Expr2 here
// are genuine averages with no bug: confirmed live that an order with items
// but zero ProcessI rows yet (order #315076) comes back with NULL Expr1-3
// rather than erroring, since SQL Server short-circuits NULL/0 to NULL
// (only 0/0 would raise a divide-by-zero, which can't happen here — COUNT
// of a non-empty joined group is always >= 1).
// pageSize caps at 5000 (not the usual 100) so the report's CSV export can
// pull the full filtered result set in a single request instead of only
// ever exporting the current 25-row page silently truncated — the default
// UI pagination still requests 25 and is unaffected.
//
// ?prudactS=&dateFrom=&dateTo=&inProgressOnly=true — mirror the legacy
// report's own Rep1/Rep2/Rep3 subs (M1 module, read via COM), confirmed as
// each one's own real Report_Open RecordSource, not guessed from captions:
//   Rep1 (noRecItemI):     WHERE PrudactS = 'X'
//   Rep2 (noRecItemIFrom): WHERE (date BETWEEN [from] AND [to]) AND PrudactS='X'
//   Rep3 (noRecItemIX):    WHERE (Colcting <> 1) AND (DateI <= Date() OR NULL)
//                                AND (oderDate <= Date() OR = Date-1 OR = Date-2) AND PrudactS='X'
// Those three all filter the RAW per-item noRecItemI rows before any
// aggregation. This endpoint's SendOrdersCI is already grouped by
// order+section (SUM/COUNT baked in), so the exact per-item date (X1I's
// `date`) and per-item `Colcting`/`DateI` aren't available post-GROUP BY —
// implemented as the closest honest equivalents at this aggregate's own
// grain instead of silently claiming an exact match: dateFrom/dateTo filter
// the order-level oderDate (not the finer per-item completion date), and
// inProgressOnly filters collectingPct < 1 (the aggregate's own direct
// equivalent of "Colcting <> 1"), dropping Rep3's narrow "ordered in the
// last 0-2 days" recency clause.
router.get("/report", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const prudactS = String(req.query.prudactS || "").trim();
        const dateFrom = String(req.query.dateFrom || "").trim();
        const dateTo = String(req.query.dateTo || "").trim();
        const inProgressOnly = req.query.inProgressOnly === "true";
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(5000, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const { total, rows } = await withSqlRetry("iron", async (pool) => {
            const whereParts = [];
            const applyInputs = (request) => {
                if (search) { request.input("search", `%${search}%`); whereParts.push("(projNo LIKE @search OR projName LIKE @search)"); }
                if (prudactS) { request.input("prudactS", prudactS); whereParts.push("PrudactS = @prudactS"); }
                if (dateFrom) { request.input("dateFrom", dateFrom); whereParts.push("oderDate >= @dateFrom"); }
                if (dateTo) { request.input("dateTo", dateTo); whereParts.push("oderDate <= @dateTo"); }
                if (inProgressOnly) whereParts.push("(Expr1 IS NULL OR Expr1 < 1)");
            };

            const countRequest = pool.request();
            applyInputs(countRequest);
            const countWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM guest.SendOrdersCI ${countWhere}`);

            whereParts.length = 0;
            const listRequest = pool.request();
            listRequest.input("offset", offset).input("pageSize", pageSize);
            applyInputs(listRequest);
            const listWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
            const listResult = await listRequest.query(`
                SELECT
                    orderNo, projNo, projName, projMgr, ProdctionNO, oderDate, PrudactS,
                    Expr2 AS cuttingPct, Expr1 AS collectingPct, Expr3 AS cutQty, SumOfquntity AS totalQty
                FROM guest.SendOrdersCI
                ${listWhere}
                ORDER BY orderNo DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            return { total: countResult.recordset[0].total, rows: listResult.recordset };
        });

        res.json({ success: true, entries: rows, total, page, pageSize });
    } catch (err) {
        console.error("❌ IRON REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch report" });
    }
});

// GET /api/iron/stock?search=&page=&pageSize= — Iron's current Main Stock
// position, the legacy Access QSTOCK form's live equivalent (SELECT * FROM
// QL2IRon, ordered by date DESC). This is a cross-database read against the
// MinStock SQL Server database (pool key "minstock", not "iron") — same
// database pushFinishedUnitToMinStock (utils/minStockSync.js) already
// writes to when an Iron item finishes. guest.QL2IRon is confirmed live and
// actively written (checked directly against the DB: 14k+ rows, newest
// dated within the last day) — it's schema-qualified as guest.QL2IRon, not
// dbo.QL2IRon. Queried directly rather than reconstructed from Stock/STOCKO
// by hand, since it's the real legacy view and already correctly scoped.
//
// QL2IRon.QTY is the item's original total, not what's still on hand — the
// view itself already computes Expr1 (shipped, via guest.OUTSUM) and Expr4
// (QTY - Expr1, the real remaining balance). Selecting raw QTY here was
// wrong: confirmed live that 14,112 of 14,168 rows (99.6%) have Expr4 <= 0
// (fully shipped already), so an unfiltered "current stock" list was
// almost entirely showing goods that already left. Same class of bug
// already fixed in mainStock.js's /orders/:orderNo/items (QTY - shipped)
// and glass.js's SQTY — applied here too: expose remaining/shipped and
// filter to genuinely on-hand rows, since this endpoint's whole purpose
// (unlike mainStock.js's per-order history view) is "what's in stock now."
router.get("/stock", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const conditions = ["Expr4 > 0"];
        if (search) conditions.push("(projNo LIKE @search OR projName LIKE @search OR Prodc LIKE @search)");
        const whereClause = `WHERE ${conditions.join(" AND ")}`;

        const { total, rows } = await withSqlRetry("minstock", async (pool) => {
            const countRequest = pool.request();
            if (search) countRequest.input("search", `%${search}%`);
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM guest.QL2IRon ${whereClause}`);

            const listRequest = pool.request();
            listRequest.input("offset", offset).input("pageSize", pageSize);
            if (search) listRequest.input("search", `%${search}%`);
            const listResult = await listRequest.query(`
                SELECT orderNo, serialNo, projNo, projName, Worker, Prodc, ProdctionNO, UNO, QTY,
                       Expr1 AS shipped, Expr4 AS remaining, Date, Note
                FROM guest.QL2IRon
                ${whereClause}
                ORDER BY Date DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            return { total: countResult.recordset[0].total, rows: listResult.recordset };
        });

        res.json({ success: true, items: rows, total, page, pageSize });
    } catch (err) {
        console.error("❌ IRON STOCK ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock" });
    }
});

export default router;
