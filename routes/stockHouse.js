// backend/routes/stockHouse.js
// Read/write API for the "Stock House" raw-material (aluminum profile) store
// — previously only reachable through a separate MS Access front-end
// (Stock_House -2021-Final -n.mdb) linked via ODBC to the same live SQL
// Server "StockHouse" database this module talks to directly. Confirmed
// against the Access app's M1 module and Main Menu VBA that the live
// workflow is: EnterDou (receive + QC) -> Reservation (reserve for project)
// -> MIX (send mill-finish stock out to an external coating company and
// receive it back finished) -> Requst (formal material request) -> StockOut
// (ship to project) / StockBack (return). ReservationF is a separate,
// earlier stage — production checking material availability against a
// ProductionNO (the same order tracked in Proj.dbo.orders) to confirm
// feasibility and lock in a schedule, before the real Reservation happens.
//
// Store scoping: the legacy app hardcoded each username to exactly one of
// three physical stores (301/302/303) in a dozen places in VBA, with two
// admin accounts seeing all stores. That's replaced here by a real
// `assignedStore` column on the user record (see models/User.js) — null
// means admin/all-store access, otherwise every query is scoped to that
// store number.
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getSqlPool } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { User } from "../models/User.js";

const router = express.Router();

router.use(authenticateToken, authorizeRoles("material_user", "admin"));

// Resolves which store a request should act on: a material_user's own
// assignedStore always wins (can't be overridden by the request body); an
// admin (assignedStore null) must say which store explicitly, since they
// have no default of their own — mirrors the legacy VBA's per-username
// store branch, just as data instead of hardcoded username checks.
function resolveStoreNo(req, bodyStoreNo) {
    if (req.user.assignedStore) return req.user.assignedStore;
    const storeNo = parseInt(bodyStoreNo, 10);
    return Number.isInteger(storeNo) ? storeNo : null;
}

// Reuses the existing ComputerNO for a known profile+color+length+store
// combination; for a genuinely new one the caller must supply one (see the
// comment on POST /enter for why this can't be generated automatically).
async function resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo }) {
    const existing = await pool.request()
        .input("profileNo", profileNo)
        .input("color", color)
        .input("linthRe", linthRe)
        .input("storeNo", storeNo)
        .query(`
            SELECT TOP 1 ComputerNO, ProfileName FROM dbo.EnterDouC
            WHERE ProfileNO = @profileNo AND Color = @color AND LinthRe = @linthRe AND StoreNo = @storeNo
        `);
    const row = existing.recordset[0];
    return {
        computerNo: row?.ComputerNO || (computerNo ? String(computerNo).trim() : null),
        profileName: row?.ProfileName || null,
    };
}

// Looks up a project's name/manager by number from the shared `Project`
// view — the same one Main Stock and Glass already join against (unions
// StockHouse.guest.ReservationO with Proj.dbo.orders). Used instead of
// trusting free-text projectName/projectManger from the client.
async function resolveProject(pool, projectNo) {
    const result = await pool.request()
        .input("projectNo", projectNo)
        .query(`SELECT TOP 1 ProjectName, ProjectManger FROM dbo.Project WHERE ProjectNO = @projectNo`);
    return result.recordset[0] || null;
}

// Looks up a real production order from Proj.dbo.orders by projectNo +
// productionNo — confirmed live that ReservationFO.ProjectNO/ProductionNO
// map 1:1 to Proj.dbo.orders.projNo/ProdctionNO (same SQL Server, direct
// cross-database query, no linked server). This is the actual "feasibility"
// check: a ReservationF request only makes sense against a production
// order that genuinely exists.
async function resolveProductionOrder(pool, projectNo, productionNo) {
    const result = await pool.request()
        .input("projectNo", projectNo)
        .input("productionNo", productionNo)
        .query(`
            SELECT TOP 1 orderNo, projName, projMgr, Color, ProdctionDate, dateFinsh
            FROM Proj.dbo.orders
            WHERE projNo = @projectNo AND ProdctionNO = @productionNo
            ORDER BY orderNo DESC
        `);
    return result.recordset[0] || null;
}

async function resolveUsername(req) {
    const user = await User.findByPk(req.user.userId, { attributes: ["username"] });
    return user?.username || String(req.user.userId);
}

// GET /api/stock-house/profile/:computerNo — look up a single item by its
// ComputerNO, the barcode-equivalent internal reference code assigned to
// each unique profile+color+length combination in this store (mirrors
// glass.js's /barcode/:barcode). Unlike Main Stock/Glass, ComputerNO here
// is a structured string (e.g. "ALMSH-00005-157360"), not a plain int.
// Store-scoped: a material_user with an assignedStore only ever sees stock
// belonging to that store; admins (assignedStore null) see any store.
router.get("/profile/:computerNo", async (req, res) => {
    try {
        const computerNo = String(req.params.computerNo || "").trim();
        if (!computerNo) {
            return res.status(400).json({ success: false, message: "computerNo required" });
        }

        const pool = await getSqlPool("stockhouse");
        const request = pool.request().input("computerNo", computerNo);

        let storeFilter = "";
        if (req.user.assignedStore) {
            request.input("storeNo", req.user.assignedStore);
            storeFilter = "AND StoreNo = @storeNo";
        }

        const result = await request.query(`
            SELECT TOP 1 ProfileNO, ProfileName, Color, LinthRe, ComputerNO, StoreNo
            FROM dbo.EnterDouC
            WHERE ComputerNO = @computerNo ${storeFilter}
        `);

        if (!result.recordset.length) {
            return res.status(404).json({ success: false, message: "No item found for this code" });
        }

        res.json({ success: true, item: result.recordset[0] });
    } catch (err) {
        console.error("❌ STOCK HOUSE PROFILE LOOKUP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to look up item" });
    }
});

// POST /api/stock-house/enter — receive raw material into the store, with
// QC evaluation as first-class fields (QtyEvl/QtyLs/QtyRej), not a
// bolted-on follow-up step. Each call creates its own EnterDouO header
// (RecordNO) with a single EnterDou detail line (SerialNo 1) — matching
// the mobile scan-one-item-at-a-time flow; there's no batching UI yet.
//
// ComputerNO: the legacy app never auto-generates this — for an
// already-known profile+color+length+store combination it's looked up and
// reused (EnterDouC), for a genuinely new combination the caller must
// supply one (the pattern staff use is loose and inconsistent, e.g.
// "ALMSH-00005-157360" for mill-finish vs "almglf-S102" for others — not
// safe to invent algorithmically).
router.post("/enter", async (req, res) => {
    try {
        const {
            profileNo, profileName, color, linthRe, computerNo,
            supplier, projectNo, qtyRe, qtyEvl, qtyLs, qtyRej,
            unite, weight, whouseOffice, qcOffice, qcTestNo, qcTestResult,
            storeNo: bodyStoreNo,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        const qty = parseInt(qtyRe, 10);
        if (!Number.isInteger(qty) || qty <= 0) {
            return res.status(400).json({ success: false, message: "A positive qtyRe is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({
                success: false,
                message: "No existing code found for this profile/color/length in this store — computerNo is required for a new combination",
            });
        }
        const resolvedComputerNo = resolved.computerNo;
        const resolvedProfileName = profileName || resolved.profileName;
        // EnterDouC (the lookup view every other endpoint depends on, via
        // resolveComputerNo) filters out rows where ProfileName IS NULL —
        // an entry created without one would be permanently unfindable by
        // profile/color/length or by ComputerNO, including from this app's
        // own /profile endpoint. Only reachable when this is a genuinely
        // new combination (an existing one always carries a profileName).
        if (!resolvedProfileName) {
            return res.status(400).json({ success: false, message: "profileName is required for a new profile/color/length combination" });
        }

        const sUser = await resolveUsername(req);

        // RecordNO is a SQL Server IDENTITY column on EnterDouO — let the
        // server generate it (OUTPUT INSERTED.RecordNO) rather than
        // computing MAX+1 ourselves, which would collide with that.
        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("whouseOffice", whouseOffice || null)
                .input("qcOffice", qcOffice || null)
                .input("qcTestNo", qcTestNo || null)
                .input("qcTestResult", qcTestResult || null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.EnterDouO (WHouseOffice, DateWHouse, QCOffice, DateQC, QCTestNo, QCTestdate, QCTestResult, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (@whouseOffice, CASE WHEN @whouseOffice IS NULL THEN NULL ELSE GETDATE() END,
                            @qcOffice, CASE WHEN @qcOffice IS NULL THEN NULL ELSE GETDATE() END,
                            @qcTestNo, CASE WHEN @qcTestResult IS NULL THEN NULL ELSE GETDATE() END, @qcTestResult,
                            @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("profileName", resolvedProfileName)
                .input("color", color)
                .input("linthRe", linthRe)
                .input("supplier", supplier || null)
                .input("projectNo", projectNo || null)
                .input("qtyRe", qty)
                .input("qtyEvl", qtyEvl !== undefined && qtyEvl !== null ? parseInt(qtyEvl, 10) : null)
                .input("qtyLs", qtyLs !== undefined && qtyLs !== null ? parseInt(qtyLs, 10) : null)
                .input("qtyRej", qtyRej !== undefined && qtyRej !== null ? parseInt(qtyRej, 10) : null)
                .input("computerNo", resolvedComputerNo)
                .input("unite", unite || null)
                .input("weight", weight !== undefined && weight !== null ? parseFloat(weight) : null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.EnterDou
                        (RecordNO, SerialNo, ProfileNO, ProfileName, Color, LinthRe, Supplier, ProjectNO,
                         QtyRe, QtyEvl, QtyLs, QtyRej, ComputerNO, QtyOut, StoreNo, Weight, Unite, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @profileName, @color, @linthRe, @supplier, @projectNo,
                         @qtyRe, @qtyEvl, @qtyLs, @qtyRej, @computerNo, 0, @storeNo, @weight, @unite, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({
            success: true,
            recordNo,
            serialNo: 1,
            computerNo: resolvedComputerNo,
            profileName: resolvedProfileName,
        });
    } catch (err) {
        console.error("❌ STOCK HOUSE ENTER ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record receipt" });
    }
});

// POST /api/stock-house/reserve — reserve stock for a project. Creates a
// ReservationO header (RecordNO, one per reservation event) with a single
// Reservation detail line. ProjectName/ProjectManger are looked up from the
// shared Project view, not trusted as free text from the client.
router.post("/reserve", async (req, res) => {
    try {
        const {
            profileNo, color, linthRe, computerNo,
            qtyRe, projectNo, note, storeNo: bodyStoreNo,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        if (!projectNo) {
            return res.status(400).json({ success: false, message: "projectNo is required" });
        }
        const qty = parseInt(qtyRe, 10);
        if (!Number.isInteger(qty) || qty <= 0) {
            return res.status(400).json({ success: false, message: "A positive qtyRe is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const project = await resolveProject(pool, projectNo);
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({
                success: false,
                message: "No existing code found for this profile/color/length in this store — computerNo is required for a new combination",
            });
        }

        const sUser = await resolveUsername(req);

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("projectNo", projectNo)
                .input("projectName", project.ProjectName)
                .input("projectManger", project.ProjectManger)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.ReservationO (ProjectNO, ProjectName, Date, ProjectManger, DateR, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (@projectNo, @projectName, GETDATE(), @projectManger, GETDATE(), @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("profileName", resolved.profileName)
                .input("color", color)
                .input("qtyRe", qty)
                .input("linthRe", linthRe)
                .input("computerNo", resolved.computerNo)
                .input("note", note || null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.Reservation
                        (RecordNO, SerialNo, ProfileNO, ProfileName, Color, QtyRe, LinthRe, ComputerNO, Note, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @profileName, @color, @qtyRe, @linthRe, @computerNo, @note, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({ success: true, recordNo, serialNo: 1, computerNo: resolved.computerNo });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create reservation" });
    }
});

// POST /api/stock-house/ship — record material physically leaving the
// store for a project/production order. Creates a StockOutO header with a
// single StockOut detail line.
router.post("/ship", async (req, res) => {
    try {
        const {
            profileNo, color, linthRe, computerNo,
            qty, projectNo, productionNo, worker, storeNo: bodyStoreNo,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        if (!projectNo) {
            return res.status(400).json({ success: false, message: "projectNo is required" });
        }
        const qtyOut = parseInt(qty, 10);
        if (!Number.isInteger(qtyOut) || qtyOut <= 0) {
            return res.status(400).json({ success: false, message: "A positive qty is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const project = await resolveProject(pool, projectNo);
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({ success: false, message: "No matching stock found for this profile/color/length in this store" });
        }

        const sUser = await resolveUsername(req);

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("projectNo", projectNo)
                .input("projectName", project.ProjectName)
                .input("productionNo", productionNo || null)
                .input("worker", worker || null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.StockOutO (ProjectNO, ProjectName, ProductionNO, Date, Worker, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (@projectNo, @projectName, @productionNo, GETDATE(), @worker, @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("color", color)
                .input("linthRe", linthRe)
                .input("qtyOut", qtyOut)
                .input("computerNo", resolved.computerNo)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.StockOut
                        (RecordNO, SerialNo, ProfileNO, Color, LinthRe, QtyOut, ComputerNO, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @color, @linthRe, @qtyOut, @computerNo, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({ success: true, recordNo, serialNo: 1, computerNo: resolved.computerNo });
    } catch (err) {
        console.error("❌ STOCK HOUSE SHIP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record shipment" });
    }
});

// POST /api/stock-house/return — record material coming back into the
// store. projectNo is optional here — real data confirms generic returns
// not tied to any specific project use the sentinel ProjectNO "stock" /
// ProjectName "Back", which is what this defaults to when omitted.
router.post("/return", async (req, res) => {
    try {
        const {
            profileNo, color, linthRe, computerNo,
            qty, projectNo, productionNo, worker, storeNo: bodyStoreNo,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        const qtyBack = parseInt(qty, 10);
        if (!Number.isInteger(qtyBack) || qtyBack <= 0) {
            return res.status(400).json({ success: false, message: "A positive qty is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        let resolvedProjectNo = "stock";
        let resolvedProjectName = "Back";
        if (projectNo) {
            const project = await resolveProject(pool, projectNo);
            if (!project) {
                return res.status(404).json({ success: false, message: "Project not found" });
            }
            resolvedProjectNo = projectNo;
            resolvedProjectName = project.ProjectName;
        }

        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({ success: false, message: "No matching stock found for this profile/color/length in this store" });
        }

        const sUser = await resolveUsername(req);

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("projectNo", resolvedProjectNo)
                .input("projectName", resolvedProjectName)
                .input("productionNo", productionNo || null)
                .input("worker", worker || null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.StockBackO (ProjectNO, ProjectName, ProductionNO, Date, Worker, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (@projectNo, @projectName, @productionNo, GETDATE(), @worker, @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("color", color)
                .input("linthRe", linthRe)
                .input("qtyOut", qtyBack)
                .input("computerNo", resolved.computerNo)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.StockBack
                        (RecordNO, SerialNo, ProfileNO, Color, LinthRe, QtyOut, ComputerNO, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @color, @linthRe, @qtyOut, @computerNo, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({ success: true, recordNo, serialNo: 1, computerNo: resolved.computerNo });
    } catch (err) {
        console.error("❌ STOCK HOUSE RETURN ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record return" });
    }
});

// POST /api/stock-house/mix/send — send mill-finish stock out to an
// external coating company to match a project's target color. Creates a
// MIXO header (RequstNo/DateRequst/NameRequst=the real coating-company name
// if supplied, the project + stock officer/manager sign-off, and the target
// FullColor) with a single MIX detail line recording what's physically
// leaving in mill finish. reservationRecordNo, if given, is the
// ReservationO.RecordNO this batch is for (stored as MIXO.SerialNO,
// matching the legacy join key).
router.post("/mix/send", async (req, res) => {
    try {
        const {
            profileNo, color, linthRe, computerNo,
            qty, fullColor, projectNo, reservationRecordNo,
            stoukOfficer, stouckManger, storeNo: bodyStoreNo, coatingCompany,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        if (!fullColor) {
            return res.status(400).json({ success: false, message: "fullColor (target coating color) is required" });
        }
        if (!projectNo) {
            return res.status(400).json({ success: false, message: "projectNo is required" });
        }
        const qtySend = parseInt(qty, 10);
        if (!Number.isInteger(qtySend) || qtySend <= 0) {
            return res.status(400).json({ success: false, message: "A positive qty is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const project = await resolveProject(pool, projectNo);
        if (!project) {
            return res.status(404).json({ success: false, message: "Project not found" });
        }

        // Sending requires the mill-finish combination to already exist in
        // this store — you can only send stock that's actually on hand.
        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({ success: false, message: "No matching mill stock found for this profile/color/length in this store" });
        }

        const sUser = await resolveUsername(req);

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("projectNo", projectNo)
                .input("projectName", project.ProjectName)
                .input("projectManger", project.ProjectManger)
                .input("stoukOfficer", stoukOfficer || null)
                .input("stouckManger", stouckManger || null)
                // Confirmed live via the legacy Access app's own VBA
                // (M1's NameRequstAC/NameRequstRequstOC subs): NameRequst
                // holds a real coating-company name for genuine sends —
                // 'IN'/'OUT' are separate sentinel values used for a
                // different MIXO record type entirely, filtered out by
                // those same subs, not something this code path writes.
                // Falls back to the previous 'MIX' placeholder only if the
                // caller genuinely didn't supply one, so existing API
                // callers don't break.
                .input("nameRequst", coatingCompany?.trim() || "MIX")
                .input("fullColor", fullColor)
                .input("serialNO", reservationRecordNo ? parseInt(reservationRecordNo, 10) : null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.MIXO
                        (RequstNo, DateRequst, NameRequst, ProjectNO, ProjectName, ProjectManger,
                         StoukOfficer, StouckManger, DateSend, SerialNO, C, FullColor, StoreNO, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES
                        (NULL, GETDATE(), @nameRequst, @projectNo, @projectName, @projectManger,
                         @stoukOfficer, @stouckManger, GETDATE(), @serialNO, 1, @fullColor, @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("profileName", resolved.profileName)
                .input("color", color)
                .input("linthRe", linthRe)
                .input("qtySend", qtySend)
                .input("computerNo", resolved.computerNo)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.MIX
                        (RecordNO, SerialNo, ProfileNO, ProfileName, QtySend, Color, LinthRe, QtyAvl, QtyOut, ComputerNO, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @profileName, @qtySend, @color, @linthRe, @qtySend, 0, @computerNo, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({ success: true, mixRecordNo: recordNo, mixSerialNo: 1 });
    } catch (err) {
        console.error("❌ STOCK HOUSE MIX SEND ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record coating send-out" });
    }
});

// POST /api/stock-house/mix/receive — record coated material coming back
// from the coating company. This both closes out the original MIX send
// (QtyOut) and adds the coated material as real, reservable stock — the
// EnterDouC lookup view every other endpoint depends on is built from
// EnterDou + Reservation only, not MIX, so coated stock has to land in
// EnterDou the same way a normal supplier delivery would, or it would
// never be findable again.
router.post("/mix/receive", async (req, res) => {
    try {
        const {
            mixRecordNo, mixSerialNo, qty,
            computerNo, profileName, storeNo: bodyStoreNo,
        } = req.body;

        const mixRn = parseInt(mixRecordNo, 10);
        const mixSn = parseInt(mixSerialNo, 10) || 1;
        if (!Number.isInteger(mixRn)) {
            return res.status(400).json({ success: false, message: "mixRecordNo is required" });
        }
        const qtyReceived = parseInt(qty, 10);
        if (!Number.isInteger(qtyReceived) || qtyReceived <= 0) {
            return res.status(400).json({ success: false, message: "A positive qty is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const mixRow = await pool.request()
            .input("recordNo", mixRn)
            .input("serialNo", mixSn)
            .input("storeNo", storeNo)
            .query(`SELECT * FROM guest.MIX WHERE RecordNO = @recordNo AND SerialNo = @serialNo AND StoreNo = @storeNo`);
        const mix = mixRow.recordset[0];
        if (!mix) {
            return res.status(404).json({ success: false, message: "No matching send-out record found for this store" });
        }

        const mixoRow = await pool.request().input("recordNo", mixRn).query(`SELECT FullColor FROM guest.MIXO WHERE RecordNO = @recordNo`);
        const targetColor = mixoRow.recordset[0]?.FullColor;

        // A coating batch can come back in more than one partial delivery —
        // accumulate QtyOut across receive calls rather than overwriting it,
        // and don't let the total exceed what was actually sent.
        const alreadyReceived = mix.QtyOut || 0;
        if (alreadyReceived + qtyReceived > mix.QtySend) {
            return res.status(400).json({
                success: false,
                message: `Only ${mix.QtySend - alreadyReceived} unit(s) remaining to receive (sent ${mix.QtySend}, already received ${alreadyReceived})`,
            });
        }

        // The coated combination (profile + target color + same length) is
        // new stock, distinct from the mill-finish combination that was sent.
        const resolved = await resolveComputerNo(pool, {
            profileNo: mix.ProfileNO, color: targetColor, linthRe: mix.LinthRe, storeNo, computerNo,
        });
        const resolvedProfileName = profileName || resolved.profileName || mix.ProfileName;
        if (!resolved.computerNo) {
            return res.status(400).json({
                success: false,
                message: "No existing code found for this coated profile/color/length — computerNo is required for a new combination",
            });
        }
        if (!resolvedProfileName) {
            return res.status(400).json({ success: false, message: "profileName is required for a new profile/color/length combination" });
        }

        const sUser = await resolveUsername(req);

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            await transaction.request()
                .input("recordNo", mixRn)
                .input("serialNo", mixSn)
                .input("qtyOut", alreadyReceived + qtyReceived)
                .query(`UPDATE guest.MIX SET QtyOut = @qtyOut WHERE RecordNO = @recordNo AND SerialNo = @serialNo`);

            const headerResult = await transaction.request()
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.EnterDouO (WHouseOffice, DateWHouse, QCOffice, DateQC, QCTestNo, QCTestdate, QCTestResult, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (NULL, NULL, NULL, NULL, NULL, NULL, NULL, @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", mix.ProfileNO)
                .input("profileName", resolvedProfileName)
                .input("color", targetColor)
                .input("linthRe", mix.LinthRe)
                .input("qtyRe", qtyReceived)
                .input("computerNo", resolved.computerNo)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.EnterDou
                        (RecordNO, SerialNo, ProfileNO, ProfileName, Color, LinthRe, QtyRe, ComputerNO, QtyOut, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @profileName, @color, @linthRe, @qtyRe, @computerNo, 0, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({
            success: true,
            enterRecordNo: recordNo,
            serialNo: 1,
            computerNo: resolved.computerNo,
            color: targetColor,
        });
    } catch (err) {
        console.error("❌ STOCK HOUSE MIX RECEIVE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record coating receipt" });
    }
});

// GET /api/stock-house/mix/outstanding?storeNo=&page=&pageSize= — individual
// MIX send records not yet fully received back from coating (QtySend >
// QtyOut), each with its own RecordNO/SerialNo — the pick list for
// POST /mix/receive's mixRecordNo/mixSerialNo. GET /remaining's inCoating
// section only returns project+profile+color+length aggregates (grouped,
// no individual record IDs), so it can't be used for picking a specific
// record to receive against; this is that per-record view.
router.get("/mix/outstanding", async (req, res) => {
    try {
        const storeNo = req.user.assignedStore || (req.query.storeNo ? parseInt(req.query.storeNo, 10) : null);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("stockhouse");
        const buildRequest = () => pool.request().input("storeNo", storeNo);

        // Same > 0 filter (not <> 0) as /remaining's inCoating section, and
        // for the same reason: some historical MIX rows from the old Access
        // app never had QtySend populated consistently, which would
        // otherwise show up here as nonsense negative-outstanding rows.
        const whereClause = "WHERE (mx.QtySend - mx.QtyOut) > 0 AND (@storeNo IS NULL OR mx.StoreNo = @storeNo)";

        const countResult = await buildRequest().query(`
            SELECT COUNT(*) AS total
            FROM guest.MIX mx JOIN guest.MIXO mo ON mx.RecordNO = mo.RecordNO
            ${whereClause}
        `);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT
                mx.RecordNO, mx.SerialNo, mo.ProjectNO, mo.ProjectName, mo.FullColor AS targetColor,
                mx.ProfileNO, mx.ProfileName, mx.Color AS millColor, mx.LinthRe, mx.StoreNo,
                mx.QtySend, mx.QtyOut, (mx.QtySend - mx.QtyOut) AS outstanding, mx.SDate
            FROM guest.MIX mx JOIN guest.MIXO mo ON mx.RecordNO = mo.RecordNO
            ${whereClause}
            ORDER BY mx.SDate DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, records: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ STOCK HOUSE MIX OUTSTANDING ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch outstanding coating records" });
    }
});

// GET /api/stock-house/mix/:recordNo — header + line items for one coating
// send-out, backing the printable coating-request document. Mirrors the
// legacy Access app's own "Requst"/"RequstO" forms and their RequstOR()/
// RequstRR() report queries (confirmed live via read-only COM/VBA
// inspection while auditing worker efficiency): those forms turned out not
// to be a separate purchase-requisition module as first guessed, but a
// printable formal-document layer bound to these same MIXO/MIX tables —
// this is that missing print step, not a new workflow. Registered after
// the literal /mix/outstanding route above so it doesn't shadow it (Express
// matches GET routes in registration order, and :recordNo would otherwise
// swallow the literal "outstanding" path segment first).
router.get("/mix/:recordNo", async (req, res) => {
    try {
        const recordNo = parseInt(req.params.recordNo, 10);
        if (!Number.isInteger(recordNo)) {
            return res.status(400).json({ success: false, message: "Invalid record number" });
        }

        const pool = await getSqlPool("stockhouse");

        const headerResult = await pool.request()
            .input("recordNo", recordNo)
            .query(`
                SELECT RecordNO, RequstNo, DateRequst, NameRequst, ProjectNO, ProjectName, ProjectManger,
                       StoukOfficer, StouckManger, DateSend, FullColor, StoreNO
                FROM guest.MIXO
                WHERE RecordNO = @recordNo
            `);
        const header = headerResult.recordset[0];
        if (!header) {
            return res.status(404).json({ success: false, message: "Record not found" });
        }

        const itemsResult = await pool.request()
            .input("recordNo", recordNo)
            .query(`
                SELECT SerialNo, ProfileNO, ProfileName, Color, LinthRe, QtySend, QtyOut,
                       (QtySend - QtyOut) AS outstanding
                FROM guest.MIX
                WHERE RecordNO = @recordNo
                ORDER BY SerialNo
            `);

        res.json({ success: true, header, items: itemsResult.recordset });
    } catch (err) {
        console.error("❌ STOCK HOUSE MIX RECORD ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch coating record" });
    }
});

// GET /api/stock-house/enter/:recordNo — backs the printable receive slip
// (mirrors the legacy Access app's "EnterDouO" report, "نموذج سند إدخال
// مواد إلى المستودع" — material warehouse entry voucher). Same
// header+items shape and print-preview pattern as GET /mix/:recordNo.
router.get("/enter/:recordNo", async (req, res) => {
    try {
        const recordNo = parseInt(req.params.recordNo, 10);
        if (!Number.isInteger(recordNo)) {
            return res.status(400).json({ success: false, message: "Invalid record number" });
        }

        const pool = await getSqlPool("stockhouse");

        const headerResult = await pool.request()
            .input("recordNo", recordNo)
            .query(`
                SELECT RecordNO, WHouseOffice, QCOffice, QCTestNo, QCTestResult, StoreNo, SUser, SDate
                FROM guest.EnterDouO
                WHERE RecordNO = @recordNo
            `);
        const header = headerResult.recordset[0];
        if (!header) {
            return res.status(404).json({ success: false, message: "Record not found" });
        }

        const itemsResult = await pool.request()
            .input("recordNo", recordNo)
            .query(`
                SELECT SerialNo, ProfileNO, ProfileName, Color, LinthRe, Supplier, ProjectNO,
                       QtyRe, QtyEvl, QtyLs, QtyRej, ComputerNO, Weight, Unite
                FROM guest.EnterDou
                WHERE RecordNO = @recordNo
                ORDER BY SerialNo
            `);

        res.json({ success: true, header, items: itemsResult.recordset });
    } catch (err) {
        console.error("❌ STOCK HOUSE ENTER RECORD ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch receive record" });
    }
});

// GET /api/stock-house/remaining?projectNo=&storeNo= — active reservations:
// what's still owed to a project (reserved but not yet shipped, net of any
// returns and re-reservation transfers), plus material currently out for
// coating that hasn't come back.
//
// This is a deliberate re-derivation from the base tables (Reservation,
// StockOut, StockBack, MIX/MIXO, ReReservation2) rather than a port of the
// legacy Details/Prodection1 view chain. That chain is genuinely deep —
// Details -> Prodection1 -> Prodection -> DateAll, a 9-way UNION across 9
// further views — and replicating it byte-for-byte would mean inheriting
// years of accumulated edge-case logic with no live-data way to fully
// verify. Checked directly against a real project's `Details` output: this
// query correctly surfaces genuine outstanding balances (e.g. reserved 631
// / shipped 48) the same way, and the legacy view's own "IN Mix" pseudo-rows
// map directly to the inCoating section below.
//
// Re-reservation/store-transfer adjustments (guest.ReReservation2) WERE
// initially left out, flagged as a real open question — confirmed live it
// matters: 1,148 real transfers moving material from one project's
// reservation to another (not just back to general Stock), the most recent
// two days before this was fixed, with real usernames attached. Confirmed
// via the legacy Access app's own VBA (read-only, M1 module's
// ReReservationC()/ReReservationC1() subs) that ReReservation2 is a flat
// event log keyed by the natural business key (ProjectNO/ProfileNO/Color/
// LinthRe), NOT a foreign key to Reservation.RecordNO — an earlier
// assumption that they joined 1:1 on RecordNO was wrong (28,510 of 34,126
// ReReservation2 rows have no matching Reservation.RecordNO at all; the
// ~5,600 that appeared to match were coincidental overlap between two
// unrelated auto-incrementing counters, confirmed by rows with the same
// "matching" RecordNO showing unrelated ProfileNO/quantities side by side).
// Two adjustments follow from that: material released FROM a project's own
// reservation (ReReservation2.ProjectNO) subtracts from what's still owed
// to it, regardless of destination; material a project received via
// another project's release (ReReservation2.ProjectNORe, when it's a real
// project rather than the literal sentinel "Stock") adds to what's owed to
// it. That second case needed the query restructured, not just a LEFT JOIN
// adjustment on the existing rows — confirmed live that 235 of 1,148 real
// transfers go to a project that has no original reservation of its own
// for that item at all, so it needs a genuinely new row, not an adjustment
// to an existing one.
router.get("/remaining", async (req, res) => {
    try {
        const { projectNo } = req.query;
        const storeNo = req.user.assignedStore || (req.query.storeNo ? parseInt(req.query.storeNo, 10) : null);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("stockhouse");
        const buildItemsRequest = () => pool.request().input("projectNo", projectNo || null).input("storeNo", storeNo);

        // Grouped by project+profile+color+length only — NOT also by
        // StoreNo — and shipped/returned/re-reservation matched the same
        // way. Checked live: 199 real reservation/shipment pairs for the
        // same project+profile+color+length are recorded under two
        // different stores (reserved from one store's stock, physically
        // shipped from another — a real, fairly common fulfillment
        // pattern here, not rare data noise). The old per-store-matched
        // join made those shipments invisible, so a fully-shipped
        // reservation still showed "remaining: <full amount>, shipped: 0"
        // forever. Grouping by StoreNo as well (rather than just matching
        // on it) also double-counted the same shipped total against every
        // store that held part of a split reservation (78 real cases,
        // confirmed live) — dropping StoreNo from the grouping key fixes
        // both. Store access is enforced via HAVING (does this
        // project/profile/color/length have any reservation, or
        // re-reservation transfer, from my store?), not a pre-aggregation
        // filter — same "access, not per-row filter" principle used in
        // /card and /stock-levels.
        //
        // Paginated for the same reason /stock-levels is: an unfiltered
        // call here returns 12k+ rows (confirmed live) — the same
        // one-giant-HTML-table lag, just not yet reported for this tab.
        const itemsCte = `
            WITH reservedBase AS (
                SELECT
                    ro.ProjectNO, MAX(ro.ProjectName) AS ProjectName,
                    r.ProfileNO, MAX(r.ProfileName) AS ProfileName,
                    r.Color, r.LinthRe, MAX(ro.StoreNo) AS StoreNo,
                    SUM(r.QtyRe) AS reserved
                FROM guest.Reservation r
                JOIN guest.ReservationO ro ON r.RecordNO = ro.RecordNO
                GROUP BY ro.ProjectNO, r.ProfileNO, r.Color, r.LinthRe
            ),
            releasedAway AS (
                -- Material released FROM a project's own reservation, to
                -- Stock or to another project — either way it's no longer
                -- owed to the original project.
                SELECT ProjectNO, ProfileNO, Color, LinthRe, MAX(StoreNo) AS StoreNo, SUM(QtyRe) AS releasedQty
                FROM guest.ReReservation2
                GROUP BY ProjectNO, ProfileNO, Color, LinthRe
            ),
            receivedTransfer AS (
                -- Material a project received via another project's
                -- release. Excludes the "Stock" sentinel (a release back
                -- to general stock, not to another project) and blanks.
                SELECT
                    ProjectNORe AS ProjectNO, MAX(ProjectNameRe) AS ProjectName,
                    ProfileNO, Color, LinthRe, MAX(StoreNo) AS StoreNo, SUM(QtyRe) AS receivedQty
                FROM guest.ReReservation2
                WHERE ProjectNORe IS NOT NULL AND LTRIM(RTRIM(ProjectNORe)) <> ''
                      AND LOWER(LTRIM(RTRIM(ProjectNORe))) <> 'stock'
                GROUP BY ProjectNORe, ProfileNO, Color, LinthRe
            ),
            projectItems AS (
                -- Every (project, item) combination with either an
                -- original reservation or a received transfer, so a
                -- project that only ever received material via transfer
                -- (no reservation of its own for that item) still shows up.
                SELECT ProjectNO, ProfileNO, Color, LinthRe FROM reservedBase
                UNION
                SELECT ProjectNO, ProfileNO, Color, LinthRe FROM receivedTransfer
            ),
            itemsBase AS (
                SELECT
                    pi.ProjectNO,
                    COALESCE(MAX(rb.ProjectName), MAX(rt.ProjectName)) AS ProjectName,
                    pi.ProfileNO, MAX(rb.ProfileName) AS ProfileName,
                    pi.Color, pi.LinthRe,
                    COALESCE(MAX(rb.StoreNo), MAX(rt.StoreNo), MAX(ra.StoreNo)) AS StoreNo,
                    ISNULL(MAX(rb.reserved), 0) AS reserved,
                    ISNULL(MAX(ra.releasedQty), 0) AS releasedAway,
                    ISNULL(MAX(rt.receivedQty), 0) AS receivedTransfer,
                    MAX(ISNULL(so.shipped, 0)) AS shipped,
                    MAX(ISNULL(sb.returned, 0)) AS returned,
                    ISNULL(MAX(rb.reserved), 0) - ISNULL(MAX(ra.releasedQty), 0) + ISNULL(MAX(rt.receivedQty), 0)
                        - MAX(ISNULL(so.shipped, 0)) + MAX(ISNULL(sb.returned, 0)) AS remaining
                FROM projectItems pi
                LEFT JOIN reservedBase rb ON rb.ProjectNO = pi.ProjectNO AND rb.ProfileNO = pi.ProfileNO AND rb.Color = pi.Color AND rb.LinthRe = pi.LinthRe
                LEFT JOIN releasedAway ra ON ra.ProjectNO = pi.ProjectNO AND ra.ProfileNO = pi.ProfileNO AND ra.Color = pi.Color AND ra.LinthRe = pi.LinthRe
                LEFT JOIN receivedTransfer rt ON rt.ProjectNO = pi.ProjectNO AND rt.ProfileNO = pi.ProfileNO AND rt.Color = pi.Color AND rt.LinthRe = pi.LinthRe
                LEFT JOIN (
                    SELECT soo.ProjectNO, so.ProfileNO, so.Color, so.LinthRe, SUM(so.QtyOut) AS shipped
                    FROM guest.StockOut so JOIN guest.StockOutO soo ON so.RecordNO = soo.RecordNO
                    GROUP BY soo.ProjectNO, so.ProfileNO, so.Color, so.LinthRe
                ) so ON so.ProjectNO = pi.ProjectNO AND so.ProfileNO = pi.ProfileNO AND so.Color = pi.Color AND so.LinthRe = pi.LinthRe
                LEFT JOIN (
                    SELECT sbo.ProjectNO, sb.ProfileNO, sb.Color, sb.LinthRe, SUM(sb.QtyOut) AS returned
                    FROM guest.StockBack sb JOIN guest.StockBackO sbo ON sb.RecordNO = sbo.RecordNO
                    GROUP BY sbo.ProjectNO, sb.ProfileNO, sb.Color, sb.LinthRe
                ) sb ON sb.ProjectNO = pi.ProjectNO AND sb.ProfileNO = pi.ProfileNO AND sb.Color = pi.Color AND sb.LinthRe = pi.LinthRe
                WHERE (@projectNo IS NULL OR pi.ProjectNO = @projectNo)
                GROUP BY pi.ProjectNO, pi.ProfileNO, pi.Color, pi.LinthRe
                HAVING ISNULL(MAX(rb.reserved), 0) - ISNULL(MAX(ra.releasedQty), 0) + ISNULL(MAX(rt.receivedQty), 0)
                           - MAX(ISNULL(so.shipped, 0)) + MAX(ISNULL(sb.returned, 0)) <> 0
                   AND (@storeNo IS NULL OR MAX(CASE WHEN COALESCE(rb.StoreNo, rt.StoreNo, ra.StoreNo) = @storeNo THEN 1 ELSE 0 END) = 1)
            )
        `;

        const itemsCountResult = await buildItemsRequest().query(`${itemsCte} SELECT COUNT(*) AS total FROM itemsBase`);
        const itemsTotal = itemsCountResult.recordset[0].total;

        const itemsListRequest = buildItemsRequest();
        itemsListRequest.input("offset", offset).input("pageSize", pageSize);
        const items = await itemsListRequest.query(`
            ${itemsCte}
            SELECT * FROM itemsBase
            ORDER BY ProjectNO, ProfileNO
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        const coatingRequest = pool.request();
        const coatingFilters = [];
        if (projectNo) {
            coatingRequest.input("projectNo", projectNo);
            coatingFilters.push("mo.ProjectNO = @projectNo");
        }
        if (storeNo) {
            coatingRequest.input("storeNo", storeNo);
            coatingFilters.push("mx.StoreNo = @storeNo");
        }
        const coatingWhere = coatingFilters.length ? `AND ${coatingFilters.join(" AND ")}` : "";

        // Filtered to > 0 (not <> 0): some historical MIX rows from the old
        // Access app never had QtySend populated consistently (0/null with
        // a real QtyOut anyway), which would otherwise show as a nonsense
        // negative "in coating" amount. Only genuinely outstanding sends —
        // this new app's own /mix/send always sets QtySend, so this only
        // affects legacy rows, not anything created going forward.
        const inCoating = await coatingRequest.query(`
            SELECT
                mo.ProjectNO, MAX(mo.ProjectName) AS ProjectName,
                mx.ProfileNO, MAX(mx.ProfileName) AS ProfileName,
                mx.Color AS millColor, MAX(mo.FullColor) AS targetColor, mx.LinthRe, mx.StoreNo,
                SUM(mx.QtySend) AS sent, SUM(mx.QtyOut) AS received,
                SUM(mx.QtySend) - SUM(mx.QtyOut) AS inCoating
            FROM guest.MIX mx JOIN guest.MIXO mo ON mx.RecordNO = mo.RecordNO
            WHERE 1=1 ${coatingWhere}
            GROUP BY mo.ProjectNO, mx.ProfileNO, mx.Color, mx.LinthRe, mx.StoreNo
            HAVING SUM(mx.QtySend) - SUM(mx.QtyOut) > 0
            ORDER BY mo.ProjectNO, mx.ProfileNO
        `);

        res.json({
            success: true,
            items: items.recordset,
            total: itemsTotal,
            page,
            pageSize,
            inCoating: inCoating.recordset,
        });
    } catch (err) {
        console.error("❌ STOCK HOUSE REMAINING ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch remaining stock" });
    }
});

// GET /api/stock-house/reservations?search=&page=&pageSize= — paginated
// list of reservation events (ReservationO headers), for the web
// dashboard's management page — mirrors glass.js's GET /orders.
router.get("/reservations", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;
        const storeNo = req.user.assignedStore || null;

        const pool = await getSqlPool("stockhouse");
        const filters = [];
        const buildRequest = () => {
            const request = pool.request();
            if (search) {
                request.input("search", `%${search}%`);
                filters.length = 0;
                filters.push("(ro.ProjectNO LIKE @search OR ro.ProjectName LIKE @search)");
            }
            if (storeNo) {
                request.input("storeNo", storeNo);
                filters.push("ro.StoreNo = @storeNo");
            }
            return request;
        };
        const whereClause = () => (filters.length ? `WHERE ${filters.join(" AND ")}` : "");

        const countResult = await buildRequest().query(`SELECT COUNT(*) AS total FROM guest.ReservationO ro ${whereClause()}`);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT
                ro.RecordNO, ro.ProjectNO, ro.ProjectName, ro.ProjectManger, ro.Date, ro.DateR, ro.StoreNo,
                COUNT(r.SerialNo) AS lineCount, ISNULL(SUM(r.QtyRe), 0) AS totalQty
            FROM guest.ReservationO ro
            LEFT JOIN guest.Reservation r ON r.RecordNO = ro.RecordNO
            ${whereClause()}
            GROUP BY ro.RecordNO, ro.ProjectNO, ro.ProjectName, ro.ProjectManger, ro.Date, ro.DateR, ro.StoreNo
            ORDER BY ro.RecordNO DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, reservations: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVATIONS LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch reservations" });
    }
});

// GET /api/stock-house/reservations/:recordNo/items — line items for one
// reservation event — mirrors glass.js's GET /orders/:orderNo/items.
router.get("/reservations/:recordNo/items", async (req, res) => {
    try {
        const recordNo = parseInt(req.params.recordNo, 10);
        if (!Number.isInteger(recordNo)) {
            return res.status(400).json({ success: false, message: "Invalid recordNo" });
        }
        const storeNo = req.user.assignedStore || null;

        const pool = await getSqlPool("stockhouse");
        const request = pool.request().input("recordNo", recordNo);
        let storeFilter = "";
        if (storeNo) {
            request.input("storeNo", storeNo);
            storeFilter = "AND StoreNo = @storeNo";
        }

        const result = await request.query(`
            SELECT SerialNo, ProfileNO, ProfileName, Color, QtyRe, LinthRe, Avl, ComputerNO, Note, StoreNo
            FROM guest.Reservation
            WHERE RecordNO = @recordNo ${storeFilter}
            ORDER BY SerialNo
        `);

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVATION ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch reservation items" });
    }
});

// --- ReservationF: production-feasibility stage (guest.ReservationF/FO) --
// Confirmed against the legacy Access app's ReservationFO/ReservationF
// forms and M1 module: this is an earlier, separate stage from a real
// Reservation — production checks whether a profile/color/length is
// available *before* committing to reserve it, against a specific
// production order (ProjectNO + ProductionNO, which map 1:1 to
// Proj.dbo.orders.projNo/ProdctionNO). Still actively used daily by the
// legacy app in parallel with this API (confirmed live activity same day
// this was built).
//
// One real difference from the legacy form: there, QtyAvl/QtyOut were
// plain manually-typed fields the VBA never computed — most live rows just
// have them at 0. Here QtyAvl is computed for real from current on-hand
// stock (same received-shipped+returned calc as GET /stock-levels), so the
// feasibility check actually means something instead of being whatever a
// user happened to type.
async function computeOnHand(pool, { profileNo, color, linthRe, storeNo, computerNo }) {
    const result = await pool.request()
        .input("profileNo", profileNo)
        .input("color", color)
        .input("linthRe", linthRe)
        .input("storeNo", storeNo)
        .input("computerNo", computerNo)
        .query(`
            SELECT
                ISNULL(SUM(qtyIn), 0) - ISNULL(SUM(qtyOut), 0) + ISNULL(SUM(qtyBack), 0) AS onHand
            FROM (
                SELECT QtyRe AS qtyIn, 0 AS qtyOut, 0 AS qtyBack FROM guest.EnterDou
                WHERE ProfileNO = @profileNo AND Color = @color AND LinthRe = @linthRe AND StoreNo = @storeNo AND ComputerNO = @computerNo

                UNION ALL

                SELECT 0, QtyOut, 0 FROM guest.StockOut
                WHERE ProfileNO = @profileNo AND Color = @color AND LinthRe = @linthRe AND StoreNo = @storeNo AND ComputerNO = @computerNo

                UNION ALL

                SELECT 0, 0, QtyOut FROM guest.StockBack
                WHERE ProfileNO = @profileNo AND Color = @color AND LinthRe = @linthRe AND StoreNo = @storeNo AND ComputerNO = @computerNo
            ) combined
        `);
    return result.recordset[0]?.onHand ?? 0;
}

// POST /api/stock-house/reservation-f — log a feasibility check against a
// production order. Creates a ReservationFO header (one per
// project+production check) with a single ReservationF detail line, same
// one-line-per-call pattern as /reserve.
router.post("/reservation-f", async (req, res) => {
    try {
        const {
            profileNo, color, linthRe, computerNo,
            qtyRe, projectNo, productionNo,
            projectNORe, colorRe, weight,
            storeNo: bodyStoreNo,
        } = req.body;

        if (!profileNo || !color || linthRe === undefined || linthRe === null) {
            return res.status(400).json({ success: false, message: "profileNo, color and linthRe are required" });
        }
        if (!projectNo || !productionNo) {
            return res.status(400).json({ success: false, message: "projectNo and productionNo are required" });
        }
        const qty = parseInt(qtyRe, 10);
        if (!Number.isInteger(qty) || qty <= 0) {
            return res.status(400).json({ success: false, message: "A positive qtyRe is required" });
        }
        const storeNo = resolveStoreNo(req, bodyStoreNo);
        if (!storeNo) {
            return res.status(400).json({ success: false, message: "storeNo is required" });
        }

        const pool = await getSqlPool("stockhouse");

        const order = await resolveProductionOrder(pool, projectNo, productionNo);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "No production order found for this project/production number",
            });
        }

        const resolved = await resolveComputerNo(pool, { profileNo, color, linthRe, storeNo, computerNo });
        if (!resolved.computerNo) {
            return res.status(400).json({ success: false, message: "No matching stock found for this profile/color/length in this store" });
        }

        const qtyAvl = await computeOnHand(pool, { profileNo, color, linthRe, storeNo, computerNo: resolved.computerNo });

        const sUser = await resolveUsername(req);
        // "No" mirrors the legacy form's ProjectNO+ProductionNO composite
        // search key (set in ProductionNO_AfterUpdate in the VBA).
        const no = `${projectNo}${productionNo}`;

        const transaction = pool.transaction();
        await transaction.begin();
        let recordNo;
        try {
            const headerResult = await transaction.request()
                .input("projectNo", projectNo)
                .input("projectName", order.projName)
                .input("productionNo", productionNo)
                .input("no", no)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.ReservationFO (ProjectNO, ProjectName, ProductionNO, Date, No, StoreNo, SUser, SDate)
                    OUTPUT INSERTED.RecordNO
                    VALUES (@projectNo, @projectName, @productionNo, GETDATE(), @no, @storeNo, @sUser, GETDATE())
                `);
            recordNo = headerResult.recordset[0].RecordNO;

            await transaction.request()
                .input("recordNo", recordNo)
                .input("profileNo", profileNo)
                .input("color", color)
                .input("linthRe", linthRe)
                .input("qtyRe", qty)
                .input("computerNo", resolved.computerNo)
                .input("qtyAvl", qtyAvl)
                .input("projectNORe", projectNORe || null)
                .input("colorRe", colorRe || null)
                .input("weight", weight !== undefined && weight !== null ? parseFloat(weight) : null)
                .input("storeNo", storeNo)
                .input("sUser", sUser)
                .query(`
                    INSERT INTO guest.ReservationF
                        (RecordNO, SerialNo, ProfileNO, Color, LinthRe, QtyRe, ComputerNO, QtyAvl, QtyOut, ProjectNORe, ColorRe, Weight, StoreNo, SUser, SDate)
                    VALUES
                        (@recordNo, 1, @profileNo, @color, @linthRe, @qtyRe, @computerNo, @qtyAvl, 0, @projectNORe, @colorRe, @weight, @storeNo, @sUser, GETDATE())
                `);

            await transaction.commit();
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        res.status(201).json({
            success: true,
            recordNo,
            serialNo: 1,
            computerNo: resolved.computerNo,
            qtyAvl,
            feasible: qtyAvl >= qty,
        });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVATION-F CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record feasibility check" });
    }
});

// GET /api/stock-house/reservation-f?search=&page=&pageSize= — paginated
// list of feasibility-check headers, mirroring GET /reservations.
router.get("/reservation-f", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;
        const storeNo = req.user.assignedStore || null;

        const pool = await getSqlPool("stockhouse");
        const filters = [];
        const buildRequest = () => {
            const request = pool.request();
            if (search) {
                request.input("search", `%${search}%`);
                filters.length = 0;
                filters.push("(fo.ProjectNO LIKE @search OR fo.ProjectName LIKE @search OR fo.ProductionNO LIKE @search)");
            }
            if (storeNo) {
                request.input("storeNo", storeNo);
                filters.push("fo.StoreNo = @storeNo");
            }
            return request;
        };
        const whereClause = () => (filters.length ? `WHERE ${filters.join(" AND ")}` : "");

        const countResult = await buildRequest().query(`SELECT COUNT(*) AS total FROM guest.ReservationFO fo ${whereClause()}`);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT
                fo.RecordNO, fo.ProjectNO, fo.ProjectName, fo.ProductionNO, fo.Date, fo.StoreNo,
                COUNT(f.SerialNo) AS lineCount,
                ISNULL(SUM(f.QtyRe), 0) AS totalQtyRe,
                ISNULL(SUM(f.QtyAvl), 0) AS totalQtyAvl,
                ISNULL(SUM(f.QtyOut), 0) AS totalQtyOut
            FROM guest.ReservationFO fo
            LEFT JOIN guest.ReservationF f ON f.RecordNO = fo.RecordNO
            ${whereClause()}
            GROUP BY fo.RecordNO, fo.ProjectNO, fo.ProjectName, fo.ProductionNO, fo.Date, fo.StoreNo
            ORDER BY fo.RecordNO DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, checks: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVATION-F LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch feasibility checks" });
    }
});

// GET /api/stock-house/reservation-f/:recordNo/items — line items for one
// feasibility-check header.
router.get("/reservation-f/:recordNo/items", async (req, res) => {
    try {
        const recordNo = parseInt(req.params.recordNo, 10);
        if (!Number.isInteger(recordNo)) {
            return res.status(400).json({ success: false, message: "Invalid recordNo" });
        }
        const storeNo = req.user.assignedStore || null;

        const pool = await getSqlPool("stockhouse");
        const request = pool.request().input("recordNo", recordNo);
        let storeFilter = "";
        if (storeNo) {
            request.input("storeNo", storeNo);
            storeFilter = "AND StoreNo = @storeNo";
        }

        const result = await request.query(`
            SELECT SerialNo, ProfileNO, Color, LinthRe, QtyRe, ComputerNO, QtyAvl, QtyOut, ProjectNORe, ColorRe, Weight, StoreNo
            FROM guest.ReservationF
            WHERE RecordNO = @recordNo ${storeFilter}
            ORDER BY SerialNo
        `);

        res.json({ success: true, items: result.recordset });
    } catch (err) {
        console.error("❌ STOCK HOUSE RESERVATION-F ITEMS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch feasibility check items" });
    }
});

// GET /api/stock-house/card/:computerNo — full transaction history (receive
// / ship / return) for one item, oldest first, with a running on-hand
// balance — mirrors the legacy Access app's "Card"/"DCard" report, which was
// the only place staff could see one item's activity over time.
//
// Store scoping here is deliberately NOT a per-transaction filter. Checked
// live: 30 real ComputerNO values have their receive recorded under one
// StoreNo and a later ship/return recorded under a different one (real
// cross-store movement/legacy data-entry drift, confirmed via
// EnterDou/StockOut/StockBack StoreNo comparison). Filtering each UNION
// branch by the caller's own store — the original approach — silently
// dropped those OUT/RETURN rows for a store-scoped material_user, making a
// genuinely shipped item look like it never left. Fixed by checking access
// once (does this ComputerNO have any activity at all under the caller's
// store?) and, if so, returning its *complete* history regardless of which
// store each individual row was recorded under — same item, one card.
router.get("/card/:computerNo", async (req, res) => {
    try {
        const computerNo = String(req.params.computerNo || "").trim();
        if (!computerNo) {
            return res.status(400).json({ success: false, message: "computerNo required" });
        }
        const storeNo = req.user.assignedStore || null;

        const pool = await getSqlPool("stockhouse");

        if (storeNo) {
            const access = await pool.request().input("computerNo", computerNo).input("storeNo", storeNo).query(`
                SELECT TOP 1 1 AS found FROM (
                    SELECT StoreNo, ComputerNO FROM guest.EnterDou
                    UNION ALL
                    SELECT StoreNo, ComputerNO FROM guest.StockOut
                    UNION ALL
                    SELECT StoreNo, ComputerNO FROM guest.StockBack
                    UNION ALL
                    SELECT StoreNo, ComputerNO FROM guest.MIX
                ) t
                WHERE t.ComputerNO = @computerNo AND t.StoreNo = @storeNo
            `);
            if (!access.recordset.length) {
                return res.status(404).json({ success: false, message: "No item found for this code in this store" });
            }
        }

        const result = await pool.request().input("computerNo", computerNo).query(`
            SELECT date, type, qty, ref, ProfileNO, ProfileName, Color, LinthRe, StoreNo, SUser,
                   SUM(balanceQty) OVER (ORDER BY date, seq, RecordNO, SerialNo ROWS UNBOUNDED PRECEDING) AS balance
            FROM (
                SELECT ed.SDate AS date, 'IN' AS type, ed.QtyRe AS qty, ed.QtyRe AS balanceQty, ed.ProjectNO AS ref,
                       ed.ProfileNO, ed.ProfileName, ed.Color, ed.LinthRe, ed.StoreNo, ed.SUser,
                       1 AS seq, ed.RecordNO, ed.SerialNo
                FROM guest.EnterDou ed
                WHERE ed.ComputerNO = @computerNo

                UNION ALL

                SELECT so.SDate, 'OUT', -so.QtyOut, -so.QtyOut, soo.ProjectNO,
                       so.ProfileNO, NULL, so.Color, so.LinthRe, so.StoreNo, so.SUser,
                       2, so.RecordNO, so.SerialNo
                FROM guest.StockOut so
                JOIN guest.StockOutO soo ON so.RecordNO = soo.RecordNO
                WHERE so.ComputerNO = @computerNo

                UNION ALL

                SELECT sb.SDate, 'RETURN', sb.QtyOut, sb.QtyOut, sbo.ProjectNO,
                       sb.ProfileNO, NULL, sb.Color, sb.LinthRe, sb.StoreNo, sb.SUser,
                       3, sb.RecordNO, sb.SerialNo
                FROM guest.StockBack sb
                JOIN guest.StockBackO sbo ON sb.RecordNO = sbo.RecordNO
                WHERE sb.ComputerNO = @computerNo

                UNION ALL

                -- Mill-finish stock sent out to the external coating company
                -- (guest.MIX/MIXO — see POST /mix/send), shown as an 'OUT' row
                -- so it's visible in the history, but deliberately excluded from
                -- the running balance (balanceQty = 0): confirmed against the
                -- legacy Access app's own M1.Card()/M1.RStock() — RStock's
                -- on-hand total is Sum(QtyIN)-Sum(QtyOut) only, with MIX's
                -- QtyAvl reported as a separate "currently at the coater" figure,
                -- never subtracted from on-hand. Netting MIX into this card's
                -- balance made it disagree with /stock-levels (Remaining Stock)
                -- for the same item — this keeps both reports consistent. Uses
                -- QtyAvl, not QtySend: checked live, 50,824 of 50,825 MIX rows
                -- have QtySend = 0 (the legacy Access app — still the primary
                -- writer of this table — has only ever populated QtyAvl for the
                -- sent quantity; QtySend appears vestigial). POST /mix/send
                -- (this app's own writer) sets both columns to the same value,
                -- so QtyAvl is correct for rows from either source.
                SELECT mx.SDate, 'OUT', -mx.QtyAvl, 0, mo.ProjectNO,
                       mx.ProfileNO, mx.ProfileName, mx.Color, mx.LinthRe, mx.StoreNo, mx.SUser,
                       4, mx.RecordNO, mx.SerialNo
                FROM guest.MIX mx
                JOIN guest.MIXO mo ON mx.RecordNO = mo.RecordNO
                WHERE mx.ComputerNO = @computerNo
            ) t
            ORDER BY date, seq, RecordNO, SerialNo
        `);

        res.json({ success: true, transactions: result.recordset });
    } catch (err) {
        console.error("❌ STOCK HOUSE CARD ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch item history" });
    }
});

// GET /api/stock-house/stock-levels?storeNo=&profileNo= — current on-hand
// quantity per item (received − shipped + returned), regardless of project
// or reservation — mirrors the legacy "RStock"/"RStock2" reports, which
// answered "how much of this do we actually have right now" as opposed to
// /remaining's "how much of what's reserved for this project is left".
router.get("/stock-levels", async (req, res) => {
    try {
        const { profileNo } = req.query;
        const storeNo = req.user.assignedStore || (req.query.storeNo ? parseInt(req.query.storeNo, 10) : null);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("stockhouse");
        const buildRequest = () => pool.request().input("profileNo", profileNo || null).input("storeNo", storeNo);

        // Grouping by ComputerNO (the item's real identity) instead of by
        // StoreNo+ProfileNO+Color+LinthRe. Checked live: the same handful
        // of items affected by the /card cross-store bug (receive recorded
        // under one store, ship/return under another — 30 ComputerNO,
        // confirmed live) were showing up here as two separate,
        // individually-confusing rows (e.g. onHand -4 under one store and
        // a phantom onHand -6 under the other, for a single physical item).
        // Store *access* is enforced separately below (hasAccess) rather
        // than filtering rows pre-aggregation, so a material_user still
        // only sees items tied to their store, but sees each item's true
        // total once — not silently split across a data-entry inconsistency.
        // Rows with no ComputerNO at all (legacy entries with no code
        // assigned) fall back to the old composite key so unrelated blank-
        // code items don't get merged into one nonsense aggregate.
        const combinedCte = `
            WITH raw AS (
                SELECT ProfileNO, ProfileName, Color, LinthRe, StoreNo, ComputerNO,
                       QtyRe AS qtyIn, 0 AS qtyOut, 0 AS qtyBack
                FROM guest.EnterDou

                UNION ALL

                SELECT so.ProfileNO, NULL, so.Color, so.LinthRe, so.StoreNo, so.ComputerNO,
                       0, so.QtyOut, 0
                FROM guest.StockOut so

                UNION ALL

                SELECT sb.ProfileNO, NULL, sb.Color, sb.LinthRe, sb.StoreNo, sb.ComputerNO,
                       0, 0, sb.QtyOut
                FROM guest.StockBack sb
            ),
            keyed AS (
                SELECT *,
                    CASE WHEN ComputerNO IS NOT NULL AND ComputerNO <> '' THEN ComputerNO
                         ELSE CONCAT('NOCODE|', ISNULL(ProfileNO, ''), '|', ISNULL(Color, ''), '|',
                                     CAST(ISNULL(LinthRe, 0) AS VARCHAR(20)), '|', CAST(StoreNo AS VARCHAR(10)))
                    END AS groupKey
                FROM raw
                WHERE @profileNo IS NULL OR ProfileNO = @profileNo
            ),
            combined AS (
                SELECT
                    MAX(ProfileNO) AS ProfileNO, MAX(ProfileName) AS ProfileName, MAX(Color) AS Color,
                    MAX(LinthRe) AS LinthRe, MAX(StoreNo) AS StoreNo, MAX(ComputerNO) AS ComputerNO,
                    SUM(qtyIn) AS totalIn, SUM(qtyOut) AS totalOut, SUM(qtyBack) AS totalBack,
                    SUM(qtyIn) - SUM(qtyOut) + SUM(qtyBack) AS onHand
                FROM keyed
                GROUP BY groupKey
                HAVING SUM(qtyIn) - SUM(qtyOut) + SUM(qtyBack) <> 0
                   AND (@storeNo IS NULL OR MAX(CASE WHEN StoreNo = @storeNo THEN 1 ELSE 0 END) = 1)
            )
        `;

        const countResult = await buildRequest().query(`${combinedCte} SELECT COUNT(*) AS total, ISNULL(SUM(onHand), 0) AS totalOnHand FROM combined`);
        const { total, totalOnHand } = countResult.recordset[0];

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            ${combinedCte}
            SELECT * FROM combined
            ORDER BY ProfileNO, Color, LinthRe
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, levels: listResult.recordset, total, totalOnHand, page, pageSize });
    } catch (err) {
        console.error("❌ STOCK HOUSE STOCK LEVELS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch stock levels" });
    }
});

// --- Profile assembly catalog (guest.ProfileNOA) -------------------------
// Confirmed against the legacy Access app's "ProfileNOA" form/M1 module:
// a "combined" profile number (ProfileNOA) mapped to up to 5 component
// "part" profile numbers (ProfileP1..P5) — e.g. a fabricated section made
// up of several separately-stocked extrusions grouped under one assembly
// number. Not store-scoped (no StoreNo column) and bound directly to the
// whole table with no per-user filtering in the legacy app, so admin-only
// here per the requested role scope — material_user has no use for
// catalog maintenance day to day.
function requireAdmin(req, res) {
    if (req.user.role !== "admin") {
        res.status(403).json({ success: false, message: "Admin access required" });
        return false;
    }
    return true;
}

// GET /api/stock-house/profile-assemblies?search=&page=&pageSize=
router.get("/profile-assemblies", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("stockhouse");
        const buildRequest = () => {
            const request = pool.request();
            if (search) request.input("search", `%${search}%`);
            return request;
        };
        const whereClause = search
            ? "WHERE ProfileNOA LIKE @search OR ProfileP1 LIKE @search OR ProfileP2 LIKE @search OR ProfileP3 LIKE @search OR ProfileP4 LIKE @search OR ProfileP5 LIKE @search"
            : "";

        const countResult = await buildRequest().query(`SELECT COUNT(*) AS total FROM guest.ProfileNOA ${whereClause}`);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT ID, ProfileNOA, ProfileP1, ProfileP2, ProfileP3, ProfileP4, ProfileP5, SUser, SDate
            FROM guest.ProfileNOA
            ${whereClause}
            ORDER BY ID DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, assemblies: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ PROFILE ASSEMBLIES LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch profile assemblies" });
    }
});

// POST /api/stock-house/profile-assemblies
router.post("/profile-assemblies", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { profileNOA, profileP1, profileP2, profileP3, profileP4, profileP5 } = req.body;
        if (!profileNOA || !String(profileNOA).trim()) {
            return res.status(400).json({ success: false, message: "profileNOA is required" });
        }

        const pool = await getSqlPool("stockhouse");
        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("profileNOA", String(profileNOA).trim())
            .input("profileP1", profileP1 || null)
            .input("profileP2", profileP2 || null)
            .input("profileP3", profileP3 || null)
            .input("profileP4", profileP4 || null)
            .input("profileP5", profileP5 || null)
            .input("sUser", sUser)
            .query(`
                INSERT INTO guest.ProfileNOA (ProfileNOA, ProfileP1, ProfileP2, ProfileP3, ProfileP4, ProfileP5, SUser, SDate)
                OUTPUT INSERTED.ID
                VALUES (@profileNOA, @profileP1, @profileP2, @profileP3, @profileP4, @profileP5, @sUser, GETDATE())
            `);

        res.status(201).json({ success: true, id: result.recordset[0].ID });
    } catch (err) {
        console.error("❌ PROFILE ASSEMBLY CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create profile assembly" });
    }
});

// PUT /api/stock-house/profile-assemblies/:id
router.put("/profile-assemblies/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ success: false, message: "Invalid id" });
        }
        const { profileNOA, profileP1, profileP2, profileP3, profileP4, profileP5 } = req.body;
        if (!profileNOA || !String(profileNOA).trim()) {
            return res.status(400).json({ success: false, message: "profileNOA is required" });
        }

        const pool = await getSqlPool("stockhouse");
        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("id", id)
            .input("profileNOA", String(profileNOA).trim())
            .input("profileP1", profileP1 || null)
            .input("profileP2", profileP2 || null)
            .input("profileP3", profileP3 || null)
            .input("profileP4", profileP4 || null)
            .input("profileP5", profileP5 || null)
            .input("sUser", sUser)
            .query(`
                UPDATE guest.ProfileNOA
                SET ProfileNOA = @profileNOA, ProfileP1 = @profileP1, ProfileP2 = @profileP2,
                    ProfileP3 = @profileP3, ProfileP4 = @profileP4, ProfileP5 = @profileP5,
                    SUser = @sUser, SDate = GETDATE()
                WHERE ID = @id
            `);

        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Profile assembly not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROFILE ASSEMBLY UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update profile assembly" });
    }
});

// DELETE /api/stock-house/profile-assemblies/:id
router.delete("/profile-assemblies/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ success: false, message: "Invalid id" });
        }

        const pool = await getSqlPool("stockhouse");
        const result = await pool.request().input("id", id).query(`DELETE FROM guest.ProfileNOA WHERE ID = @id`);

        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Profile assembly not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ PROFILE ASSEMBLY DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete profile assembly" });
    }
});

// --- Item Profiles (guest.ItemProfile) ---------------------------------
// New admin-only catalog for raw-material items — name, free-text details,
// and a photo, so staff can visually identify a profile/color/length combo
// rather than working from the code alone. No legacy Access equivalent:
// confirmed earlier this session there is no editable profile-name master
// table anywhere in this schema (dbo.ProfileNo is a read-only view over
// transaction history), so this is a genuinely new table (guest.ItemProfile:
// ID, ProfileNO, ProfileName, Details, PhotoUrl, SUser, SDate), not a port.
// Same admin-only gating as ProfileNOA (profile-assemblies) above — this is
// catalog maintenance, not day-to-day warehouse work.
const itemPhotosDir = path.resolve(process.cwd(), "uploads/item-photos");
fs.mkdirSync(itemPhotosDir, { recursive: true });

const itemPhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, itemPhotosDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
        const uniqueName = Date.now() + "-" + Math.random().toString(36).substring(2, 10) + ext;
        cb(null, uniqueName);
    },
});
const allowedPhotoExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const photoMimeRegex = /^image\/(jpeg|png|gif|webp|bmp)$/;
const itemPhotoUpload = multer({
    storage: itemPhotoStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (photoMimeRegex.test(file.mimetype) && allowedPhotoExts.has(ext)) return cb(null, true);
        return cb(new Error("Only valid image files are allowed"));
    },
    limits: { fileSize: 2 * 1024 * 1024 },
});

// GET /api/stock-house/item-profiles?search=&page=&pageSize=
router.get("/item-profiles", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
        const offset = (page - 1) * pageSize;

        const pool = await getSqlPool("stockhouse");
        const buildRequest = () => {
            const request = pool.request();
            if (search) request.input("search", `%${search}%`);
            return request;
        };
        const whereClause = search ? "WHERE ProfileNO LIKE @search OR ProfileName LIKE @search" : "";

        const countResult = await buildRequest().query(`SELECT COUNT(*) AS total FROM guest.ItemProfile ${whereClause}`);
        const total = countResult.recordset[0].total;

        const listRequest = buildRequest();
        listRequest.input("offset", offset).input("pageSize", pageSize);
        const listResult = await listRequest.query(`
            SELECT ID, ProfileNO, ProfileName, Details, PhotoUrl, SUser, SDate
            FROM guest.ItemProfile
            ${whereClause}
            ORDER BY ID DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
        `);

        res.json({ success: true, profiles: listResult.recordset, total, page, pageSize });
    } catch (err) {
        console.error("❌ ITEM PROFILES LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch item profiles" });
    }
});

// POST /api/stock-house/item-profiles
router.post("/item-profiles", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { profileNO, profileName, details } = req.body;
        if (!profileNO || !String(profileNO).trim()) {
            return res.status(400).json({ success: false, message: "profileNO is required" });
        }
        if (!profileName || !String(profileName).trim()) {
            return res.status(400).json({ success: false, message: "profileName is required" });
        }

        const pool = await getSqlPool("stockhouse");
        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("profileNO", String(profileNO).trim())
            .input("profileName", String(profileName).trim())
            .input("details", details ? String(details).trim() : null)
            .input("sUser", sUser)
            .query(`
                INSERT INTO guest.ItemProfile (ProfileNO, ProfileName, Details, SUser, SDate)
                OUTPUT INSERTED.ID
                VALUES (@profileNO, @profileName, @details, @sUser, GETDATE())
            `);

        res.status(201).json({ success: true, id: result.recordset[0].ID });
    } catch (err) {
        console.error("❌ ITEM PROFILE CREATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to create item profile" });
    }
});

// PUT /api/stock-house/item-profiles/:id
router.put("/item-profiles/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ success: false, message: "Invalid id" });
        }
        const { profileNO, profileName, details } = req.body;
        if (!profileNO || !String(profileNO).trim()) {
            return res.status(400).json({ success: false, message: "profileNO is required" });
        }
        if (!profileName || !String(profileName).trim()) {
            return res.status(400).json({ success: false, message: "profileName is required" });
        }

        const pool = await getSqlPool("stockhouse");
        const sUser = await resolveUsername(req);
        const result = await pool.request()
            .input("id", id)
            .input("profileNO", String(profileNO).trim())
            .input("profileName", String(profileName).trim())
            .input("details", details ? String(details).trim() : null)
            .input("sUser", sUser)
            .query(`
                UPDATE guest.ItemProfile
                SET ProfileNO = @profileNO, ProfileName = @profileName, Details = @details,
                    SUser = @sUser, SDate = GETDATE()
                WHERE ID = @id
            `);

        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Item profile not found" });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ ITEM PROFILE UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update item profile" });
    }
});

// DELETE /api/stock-house/item-profiles/:id — also removes the photo file
// from disk, if one was set, so uploads/item-photos doesn't accumulate
// orphaned files.
router.delete("/item-profiles/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ success: false, message: "Invalid id" });
        }

        const pool = await getSqlPool("stockhouse");
        const existing = await pool.request().input("id", id).query(`SELECT PhotoUrl FROM guest.ItemProfile WHERE ID = @id`);
        const photoUrl = existing.recordset[0]?.PhotoUrl;

        const result = await pool.request().input("id", id).query(`DELETE FROM guest.ItemProfile WHERE ID = @id`);
        if (!result.rowsAffected[0]) {
            return res.status(404).json({ success: false, message: "Item profile not found" });
        }

        if (photoUrl) {
            const photoPath = path.join(itemPhotosDir, path.basename(photoUrl));
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ ITEM PROFILE DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete item profile" });
    }
});

// POST /api/stock-house/item-profiles/:id/photo — same multer pattern as
// upload.js's avatar upload (2MB limit, image types only), scoped to its
// own uploads/item-photos directory. Replaces (and deletes) any previous
// photo for this profile.
router.post("/item-profiles/:id/photo", itemPhotoUpload.single("photo"), async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ success: false, message: "Invalid id" });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No image uploaded" });
        }

        const pool = await getSqlPool("stockhouse");
        const existing = await pool.request().input("id", id).query(`SELECT PhotoUrl FROM guest.ItemProfile WHERE ID = @id`);
        if (!existing.recordset[0]) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, message: "Item profile not found" });
        }

        const oldPhotoUrl = existing.recordset[0].PhotoUrl;
        await pool.request()
            .input("id", id)
            .input("photoUrl", req.file.filename)
            .query(`UPDATE guest.ItemProfile SET PhotoUrl = @photoUrl WHERE ID = @id`);

        if (oldPhotoUrl) {
            const oldPath = path.join(itemPhotosDir, path.basename(oldPhotoUrl));
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        res.json({ success: true, photoUrl: req.file.filename });
    } catch (err) {
        console.error("❌ ITEM PROFILE PHOTO UPLOAD ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to upload photo" });
    }
});

export default router;
