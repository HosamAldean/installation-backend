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
//     doesn't invent a barcode formula. CORRECTED from an earlier decision
//     that had it as a plain optional web-editable int: legacy has no
//     barcode textbox anywhere in the item form or its reports (a pure
//     backend column, never hand-typed), so exposing a free-entry field
//     here was itself the bug — it let a web user type a value that
//     collides with another item's real barcode, something legacy
//     structurally couldn't produce. Read-only/display-only now; see the
//     items POST/PUT handlers below.
//   - D1I (notes) has no Action/ActionDate columns — just Ditails/
//     DitalsDate, a flatter event log than Proj's D1. TWICE corrected: an
//     earlier assumption (row counts 1/11/3/0 on D1I1-4 vs 23 on D1I) read
//     this as "one real table, rest unused duplicates" like Proj's D2-D5 —
//     but that only checked row counts, not the VBA. Direct M1 module
//     inspection shows M1.D1I() (called from Form_D1I's Form_Load) branches
//     on the exact same department signal as the event log below
//     (Form_SendordersI.Label18.Caption) to route to D1I1/D1I2/D1I3/D1I4 —
//     genuine department scoping, just with low historical note counts.
//     See the notes route below for the full mapping and the ID-column
//     caveat on D1I2/D1I4.
//   - X1I (event log) is structurally identical to Proj's x1 (xc1-3
//     checkboxes, x1/x2 generic-labeled value fields, a completion date) —
//     same generic "x1"/"x2" Label captions confirmed live, so exposed the
//     same way. CORRECTED from an earlier assumption: unlike D1I/D2-D5
//     (genuinely one real table plus unused near-duplicates), X1I1-4 here
//     ARE a real department dimension, same idea as Proj's x1-x5 — each is
//     a distinct department's own inquiry screen off the Main Menu (MIX/
//     Steel/Maintenance/Factory — corrected a second time from an initial
//     caption-based mistranslation, see the event-log route below for the
//     verified Click-handler-to-table mapping), and 52% of orders present
//     in both X1I and X1I2 have a genuinely different completion date
//     between them. All five tables are read/written by department. See
//     PUT/GET .../event-log for the full detail.
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
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { User } from "../models/User.js";
import { pushFinishedUnitToMinStock } from "../utils/minStockSync.js";

const router = express.Router();

// Grain matches the old authorizeReadWrite split's superset (view roles
// already included everyone who could edit) -- one key covers both tiers,
// per this codebase's "one key per page" convention (see the permission-
// system plan). installation_manager/production/admin were the only
// roles with any access before; seeded to match exactly.
router.use(authenticateToken, requirePermission(PERMISSIONS.INSTALLATION_IRON));

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

// GET /api/iron/project-lookup/:projNo — canonical manager/name for a
// project number, from guest.Project (2,824 rows). Matches the legacy
// ordersI form's projNo_AfterUpdate -> Project() VBA sub, which overwrites
// projMgr/projName from this table the moment a project number is entered
// -- confirmed live via COM/VBA inspection. Restoring this stops two orders
// for the same project from silently ending up with two different manager
// names on record, which the legacy app structurally prevented and this
// app previously didn't.
router.get("/project-lookup/:projNo", async (req, res) => {
    const projNo = String(req.params.projNo || "").trim();
    if (!projNo) {
        return res.status(400).json({ success: false, message: "projNo is required" });
    }
    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("projNo", projNo)
            .query(`
                SELECT TOP 1 ProjectManger AS projMgr, ProjectName AS projName
                FROM guest.Project
                WHERE ProjectNO = @projNo
            `));
        if (result.recordset.length === 0) {
            return res.json({ success: true, project: null });
        }
        res.json({ success: true, project: result.recordset[0] });
    } catch (err) {
        console.error("❌ IRON PROJECT LOOKUP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to look up project" });
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
// barcode is NOT accepted as client input (deliberate — see the audit
// finding this closes out): legacy has no barcode textbox anywhere in the
// item form or its reports, it's a pure backend column never hand-typed,
// and there's no reliable generation formula to invent one with either
// (confirmed live: only 1,811 of 14,953 rows are non-zero, no evident
// pattern on the populated ones — see file header). Rather than either
// inventing a fake formula or leaving it web-editable (letting a user type
// a value that collides with another item's real barcode), new rows are
// always inserted with barcode = NULL, same as the column's own dominant
// live state.
router.post("/:orderNo/items", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    if (!Number.isInteger(orderNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo" });
    }
    const { itemNo, Prudact, dimenisons, quntity, color, note, referenceI, referenceM, location, prudactS } = req.body;

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
                    .query(`
                        INSERT INTO dbo.orderdetailsI
                            (orderNo, serialNo, itemNo, Prudact, dimenisons, quntity, color, note,
                             referenceI, referenceM, Location, PrudactS)
                        VALUES
                            (@orderNo, @serialNo, @itemNo, @Prudact, @dimenisons, @quntity, @color, @note,
                             @referenceI, @referenceM, @location, @prudactS)
                    `);

                // Legacy created the matching ProcessI row in lockstep with
                // the line item -- orderdetailsI's own updatable-join
                // mechanics (IDNo1(), confirmed via COM/VBA) inserted it the
                // instant a new item's itemNo was set. This app used to
                // create it lazily, only on the first Status-dialog save,
                // so an untouched line had no ProcessI row at all and came
                // back as a NULL (not 0%) cutting/collecting average in
                // GET /report -- a state the legacy app could never reach.
                // Cuting/Colcting=0 (not left NULL) so the line is counted
                // as "not yet processed" in that average from the moment it
                // exists, matching what a freshly-added legacy line meant.
                await transaction.request()
                    .input("orderNo", orderNo)
                    .input("serialNo", serialNo)
                    .query(`
                        INSERT INTO dbo.ProcessI (orderNo, serialNo, Cuting, Colcting)
                        VALUES (@orderNo, @serialNo, 0, 0)
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
// row itself (specs/qty/references), not the cutting/prep status. barcode
// is deliberately not writable here either — see the POST handler above —
// so an edit leaves whatever value (usually NULL) already exists untouched.
router.put("/:orderNo/items/:serialNo", async (req, res) => {
    const orderNo = parseInt(req.params.orderNo, 10);
    const serialNo = parseInt(req.params.serialNo, 10);
    if (!Number.isInteger(orderNo) || !Number.isInteger(serialNo)) {
        return res.status(400).json({ success: false, message: "Invalid orderNo or serialNo" });
    }
    const { itemNo, Prudact, dimenisons, quntity, color, note, referenceI, referenceM, location, prudactS } = req.body;

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
            .query(`
                UPDATE dbo.orderdetailsI
                SET itemNo = @itemNo, Prudact = @Prudact, dimenisons = @dimenisons, quntity = @quntity,
                    color = @color, note = @note, referenceI = @referenceI, referenceM = @referenceM,
                    Location = @location, PrudactS = @prudactS
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

// --- Order notes (dbo.D1I / D1I1-4, department-scoped) -----------------
// CORRECTED from an earlier assumption that D1I1-4 (row counts 1/11/3/0)
// were near-unused duplicates like Proj's D2-D5. Direct COM/VBA inspection
// of the M1 module proved otherwise: M1.D1I() (called from Form_D1I's
// Form_Load) actively branches on Form_SendordersI.Label18.Caption — the
// exact same department label ("MIX"/"Steel"/"Maintenance"/"Factory") set
// by SendordersI1-4, which is itself keyed off the live dbo.PrudactS lookup
// (confirmed live: MIX/Steel/Maintenance/Factory, id 5/2/3/4) already used
// throughout this file's item-report endpoints — and routes the notes form
// to D1I1/D1I2/D1I3/D1I4 respectively, falling back to D1I only when no
// department context is set. This is real, deliberate department scoping,
// not leftover cruft; the earlier low-row-count read was an incomplete
// read that missed the VBA routing entirely.
//
// D1I, D1I1, and D1I3 have a real ID identity column (confirmed live
// schema); D1I2 and D1I4 do NOT — there is no stable per-row identifier in
// those two tables to target for edit/delete without a schema change
// (a bigger, separate decision, flagged rather than silently applied), so
// PUT/DELETE below only support the three ID-bearing tables.
//
// Keys are lowercase to match this file's existing IRON_EVENT_LOG_DEPARTMENTS
// convention (and what the frontend's IronDepartment type actually sends) —
// not the live PrudactS casing ("MIX"/"Steel"/...) itself, which is only
// what the legacy VBA compares Label18.Caption against internally.
const NOTE_TABLE_BY_DEPARTMENT = {
    mix: "D1I1",
    steel: "D1I2",
    maintenance: "D1I3",
    factory: "D1I4",
};
const NOTE_TABLES_WITH_ID = new Set(["D1I", "D1I1", "D1I3"]);
function resolveNoteTable(department) {
    return NOTE_TABLE_BY_DEPARTMENT[department] || "D1I";
}

router.get("/:orderNo/notes", async (req, res) => {
    try {
        const orderNo = parseInt(req.params.orderNo, 10);
        if (!Number.isInteger(orderNo)) {
            return res.status(400).json({ success: false, message: "Invalid orderNo" });
        }
        const table = resolveNoteTable(String(req.query.department || "").trim());
        const hasId = NOTE_TABLES_WITH_ID.has(table);

        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("orderNo", orderNo)
            .query(`
                SELECT ${hasId ? "ID," : ""} Ditails, DitalsDate
                FROM dbo.${table}
                WHERE orderno = @orderNo
                ORDER BY ${hasId ? "ID" : "DitalsDate"} DESC
            `));

        res.json({ success: true, notes: result.recordset, canEdit: hasId });
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
    const { ditails, department } = req.body;
    if (!ditails || !String(ditails).trim()) {
        return res.status(400).json({ success: false, message: "ditails is required" });
    }
    const table = resolveNoteTable(String(department || "").trim());
    const hasId = NOTE_TABLES_WITH_ID.has(table);

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
                    INSERT INTO dbo.${table} (orderno, Ditails, DitalsDate)
                    ${hasId ? "OUTPUT INSERTED.ID" : ""}
                    VALUES (@orderNo, @ditails, GETDATE())
                `);
        });

        if (!result) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(201).json({ success: true, id: hasId ? result.recordset[0].ID : null });
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
    const { ditails, department } = req.body;
    if (!ditails || !String(ditails).trim()) {
        return res.status(400).json({ success: false, message: "ditails is required" });
    }
    const table = resolveNoteTable(String(department || "").trim());
    if (!NOTE_TABLES_WITH_ID.has(table)) {
        return res.status(400).json({ success: false, message: "Notes in this department can't be edited — the legacy table has no row identifier" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request()
            .input("id", id)
            .input("ditails", String(ditails).trim())
            .query(`UPDATE dbo.${table} SET Ditails = @ditails WHERE ID = @id`));
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
    const table = resolveNoteTable(String(req.query.department || "").trim());
    if (!NOTE_TABLES_WITH_ID.has(table)) {
        return res.status(400).json({ success: false, message: "Notes in this department can't be deleted — the legacy table has no row identifier" });
    }

    try {
        const result = await withSqlRetry("iron", (pool) => pool.request().input("id", id).query(`DELETE FROM dbo.${table} WHERE ID = @id`));
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
// duplicates of X1I. First confirmed live via the Main Menu's own button
// captions (COM-inspected) that each is a distinct department's inquiry
// screen; the department NAMES below are a second, later correction of
// that same finding — the button captions ("specified/designated works"
// for X1I2, "lathe/turning work" for X1I3) turned out to be a mistranslation
// of what those buttons actually route to. Traced the real chain instead
// of trusting the caption text: Main Menu Command41/42/43/44's Click
// handlers call M1.SendordersI1/2/3/4 directly (not just similarly-named
// subs — literally the same call), each of which sets
// Form_SendordersI.Label18.Caption to "MIX"/"Steel"/"Maintenance"/"Factory"
// respectively (and filters by the exact same string against the live
// dbo.PrudactS lookup — confirmed live values: MIX/Steel/Maintenance/
// Factory). M1.X1I() (and M1.D1I(), see the notes section below) then
// branches on that same Label18.Caption to pick X1I1/X1I2/X1I3/X1I4. So
// Command42 -> SendordersI2 -> "Steel" -> X1I2, and Command43 ->
// SendordersI3 -> "Maintenance" -> X1I3 — not specifiedWorks/lathe as
// originally labeled. Confirmed live that this isn't redundant tracking:
// of the ~3,362 orders present in both X1I and X1I2, 52% have a genuinely
// different x3 completion date between the two tables. Reading/writing
// only X1I (as this endpoint used to) means the app is blind to — or edits
// the wrong record for — any order whose real status lives in a department
// table instead. xc4/xc5 exist on all five tables but are confirmed
// entirely unused (0 non-zero rows across all five, live) — not exposed
// here, matching the legacy form which never shows them either.
const IRON_EVENT_LOG_DEPARTMENTS = {
    production: "X1I",
    mix: "X1I1",
    steel: "X1I2",
    maintenance: "X1I3",
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

    // xc1/xc2/xc3 (Optionx1/2/3 in the legacy form) were a mutually-exclusive
    // tri-state enforced by VBA -- each option's _Click handler disabled the
    // other two, so at most one was ever true at a time. This app used to
    // expose them as three independent checkboxes with no such rule, which
    // let a unit get saved in two contradictory stages at once. Reject that
    // outright rather than silently normalizing it, so a caller (the
    // frontend now prevents this client-side too) finds out immediately.
    if (Array.isArray(checkboxes) && checkboxes.filter(Boolean).length > 1) {
        return res.status(400).json({
            success: false,
            message: "Only one stage can be active at a time",
        });
    }

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
// ?blended=true — the legacy report's OWN default view (Main Menu Command1,
// no department button pressed): M1.SendordersI() (COM/VBA-confirmed, not
// guessed) sets Form_SendordersI.RecordSource to
//   SELECT ... Avg(Expr1) AS Expr11, Avg(Expr2) AS Expr12, SUM(Expr3) AS Expr13, ...
//   FROM SendOrdersCI INNER JOIN X1I ON SendOrdersCI.orderNo = X1I.orderno
//   GROUP BY SendOrdersCI.orderno, projNo, projName, projMgr, oderDate, ProdctionNO
// i.e. it takes this endpoint's own per-(order,section) SendOrdersCI rows
// and averages them again, one level up, into a single blended row per
// order — genuinely different from ?prudactS=X (which narrows to one
// section) or the unfiltered default (one row per section, still split).
// Ported as a literal AVG(Expr1)/AVG(Expr2) re-aggregation (a "mean of
// means" across sections, not a qty-weighted average) since that's exactly
// what the legacy VBA computes — not "improved" into a different formula.
// The INNER JOIN X1I is preserved too: confirmed live it drops only 13 of
// 6,291 orders (99.8% have an X1I row), matching legacy behavior with
// negligible practical difference rather than silently loosening it to
// LEFT JOIN.
router.get("/report", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const prudactS = String(req.query.prudactS || "").trim();
        const dateFrom = String(req.query.dateFrom || "").trim();
        const dateTo = String(req.query.dateTo || "").trim();
        const inProgressOnly = req.query.inProgressOnly === "true";
        const blended = req.query.blended === "true";
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(5000, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        if (blended) {
            const { total, rows } = await withSqlRetry("iron", async (pool) => {
                const whereParts = [];
                const applyInputs = (request) => {
                    if (search) { request.input("search", `%${search}%`); whereParts.push("(s.projNo LIKE @search OR s.projName LIKE @search)"); }
                    if (dateFrom) { request.input("dateFrom", dateFrom); whereParts.push("s.oderDate >= @dateFrom"); }
                    if (dateTo) { request.input("dateTo", dateTo); whereParts.push("s.oderDate <= @dateTo"); }
                };

                const baseFrom = `
                    FROM guest.SendOrdersCI s
                    INNER JOIN dbo.X1I x ON s.orderNo = x.orderno
                `;
                const groupBy = "GROUP BY s.orderNo, s.projNo, s.projName, s.projMgr, s.oderDate, s.ProdctionNO";
                const having = inProgressOnly ? "HAVING (AVG(s.Expr1) IS NULL OR AVG(s.Expr1) < 1)" : "";

                const countRequest = pool.request();
                applyInputs(countRequest);
                const countWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
                const countResult = await countRequest.query(`
                    SELECT COUNT(*) AS total FROM (
                        SELECT s.orderNo ${baseFrom} ${countWhere} ${groupBy} ${having}
                    ) t
                `);

                whereParts.length = 0;
                const listRequest = pool.request();
                listRequest.input("offset", offset).input("pageSize", pageSize);
                applyInputs(listRequest);
                const listWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
                const listResult = await listRequest.query(`
                    SELECT
                        s.orderNo, s.projNo, s.projName, s.projMgr, s.oderDate, s.ProdctionNO,
                        AVG(s.Expr2) AS cuttingPct, AVG(s.Expr1) AS collectingPct,
                        SUM(s.Expr3) AS cutQty, SUM(s.SumOfquntity) AS totalQty,
                        COUNT(*) AS sectionCount
                    ${baseFrom}
                    ${listWhere}
                    ${groupBy}
                    ${having}
                    ORDER BY s.orderNo DESC
                    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
                `);

                return { total: countResult.recordset[0].total, rows: listResult.recordset };
            });

            return res.json({ success: true, entries: rows, total, page, pageSize, blended: true });
        }

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

// GET /api/iron/items-report?prudactS=&mode=&dateFrom=&dateTo=&page=&pageSize=
// The three raw item-level reports GET /report's aggregate can't reproduce
// (it's already GROUP BY order+section) — confirmed live via COM/VBA that
// each is a real, reachable report (SendordersI's department buttons ->
// Rep1/Rep2/Rep3 in module M1), not guessed from captions, all three built
// on the same underlying view, dbo.noRecItemI (pulled directly via
// OBJECT_DEFINITION, not reconstructed): an INNER JOIN chain through X1I,
// ProcessI, orderdetailsI, ordersI. Because every join is INNER, a line
// with no event-log row (X1I) or no status row (ProcessI) is invisible
// here even though it exists in ordersI/orderdetailsI -- the same "no
// ProcessI row yet" gap POST /:orderNo/items now closes for new lines
// (older lines predating that fix can still be missing here, matching
// legacy's own real behavior, not a bug introduced by this endpoint).
//   mode=all       (Rep1/noRecItemI):     WHERE PrudactS = @prudactS
//   mode=dateRange (Rep2/noRecItemIFrom): WHERE date BETWEEN @dateFrom AND @dateTo [AND PrudactS = @prudactS]
//   mode=inProgress(Rep3/noRecItemIX):    WHERE Colcting <> 1 AND (DateI <= GETDATE() OR DateI IS NULL)
//                                               AND (CAST(oderDate AS DATE) IN (CAST(GETDATE() AS DATE), <-1d>, <-2d>))
//                                               [AND PrudactS = @prudactS]
// prudactS is optional in all three modes, matching Rep1/2/3's own Else
// branch (no section selected -> no PrudactS filter, not "no results").
router.get("/items-report", async (req, res) => {
    try {
        const prudactS = String(req.query.prudactS || "").trim();
        const mode = String(req.query.mode || "all").trim();
        const dateFrom = String(req.query.dateFrom || "").trim();
        const dateTo = String(req.query.dateTo || "").trim();
        if (mode === "dateRange" && (!dateFrom || !dateTo)) {
            return res.status(400).json({ success: false, message: "dateFrom and dateTo are required for mode=dateRange" });
        }
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(5000, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const { total, rows, totals } = await withSqlRetry("iron", async (pool) => {
            const whereParts = [];
            const applyInputs = (request) => {
                if (prudactS) { request.input("prudactS", prudactS); whereParts.push("PrudactS = @prudactS"); }
                if (mode === "dateRange") {
                    request.input("dateFrom", dateFrom).input("dateTo", dateTo);
                    whereParts.push("(date BETWEEN @dateFrom AND @dateTo)");
                } else if (mode === "inProgress") {
                    whereParts.push(`
                        (Colcting <> 1)
                        AND (DateI <= GETDATE() OR DateI IS NULL)
                        AND (
                            CAST(oderDate AS DATE) = CAST(GETDATE() AS DATE)
                            OR CAST(oderDate AS DATE) = CAST(DATEADD(day, -1, GETDATE()) AS DATE)
                            OR CAST(oderDate AS DATE) = CAST(DATEADD(day, -2, GETDATE()) AS DATE)
                        )
                    `);
                }
            };

            const countRequest = pool.request();
            applyInputs(countRequest);
            const countWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM dbo.noRecItemI ${countWhere}`);

            // Footer running totals, COM-confirmed against the legacy
            // Form_ProcessI's own FormFooter controls (Text43=Sum([quntity]),
            // Text36=Avg([cuting]), Text23=Avg([Colcting])) bound to this
            // exact noRecItemI recordset -- computed across the whole
            // filtered set (matching Access's live footer behavior), not
            // just the current page.
            whereParts.length = 0;
            const totalsRequest = pool.request();
            applyInputs(totalsRequest);
            const totalsWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
            const totalsResult = await totalsRequest.query(`
                SELECT SUM(quntity) AS totalQty, AVG(CAST(Cuting AS FLOAT)) AS avgCuting, AVG(CAST(Colcting AS FLOAT)) AS avgColcting
                FROM dbo.noRecItemI
                ${totalsWhere}
            `);

            whereParts.length = 0;
            const listRequest = pool.request();
            listRequest.input("offset", offset).input("pageSize", pageSize);
            applyInputs(listRequest);
            const listWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
            const listResult = await listRequest.query(`
                SELECT
                    orderNo, serialNo, itemNo, PrudactS, Prudact, dimenisons, quntity, color, note,
                    referenceI, referenceM, barcode, Location, Cuting, Colcting, DateI, finaldate,
                    date, ProdctionNO, projNo, projName, oderDate
                FROM dbo.noRecItemI
                ${listWhere}
                ORDER BY orderNo DESC, serialNo ASC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            `);

            return { total: countResult.recordset[0].total, rows: listResult.recordset, totals: totalsResult.recordset[0] };
        });

        res.json({
            success: true,
            items: rows,
            total,
            page,
            pageSize,
            totals: {
                qty: totals.totalQty ?? 0,
                cutingPct: totals.avgCuting ?? null,
                colctingPct: totals.avgColcting ?? null,
            },
        });
    } catch (err) {
        console.error("❌ IRON ITEMS REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch items report" });
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

        const { total, rows, totalRemaining } = await withSqlRetry("minstock", async (pool) => {
            const countRequest = pool.request();
            if (search) countRequest.input("search", `%${search}%`);
            const countResult = await countRequest.query(`SELECT COUNT(*) AS total FROM guest.QL2IRon ${whereClause}`);

            // The legacy QSTOCK form's own FormFooter (COM-confirmed:
            // Text26, ControlSource =Sum([QTY])) totals across the whole
            // filtered recordset, not just one page. Summed here as
            // Expr4/remaining rather than raw QTY to match this endpoint's
            // own already-established correction above (QTY is the
            // original total, not what's actually on hand) -- a straight
            // Sum(QTY) footer would reintroduce the exact "mostly already
            // shipped" distortion that fix exists to avoid.
            const totalsRequest = pool.request();
            if (search) totalsRequest.input("search", `%${search}%`);
            const totalsResult = await totalsRequest.query(`SELECT SUM(Expr4) AS totalRemaining FROM guest.QL2IRon ${whereClause}`);

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

            return { total: countResult.recordset[0].total, rows: listResult.recordset, totalRemaining: totalsResult.recordset[0].totalRemaining ?? 0 };
        });

        res.json({ success: true, items: rows, total, page, pageSize, totalRemaining });
    } catch (err) {
        console.error("❌ IRON STOCK ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock" });
    }
});

export default router;
