// backend/routes/ittihadAttendance.js
// HR-only import/review/confirm flow for Ittihad company (CompNo=10)
// attendance. Source data is a plain tab-delimited log exported by the
// Realand RAMS ("RAS.exe") access-control software:
//   User ID <TAB> Clock Time (DD/MM/YYYY h:mm:ss AM/PM) <TAB> Att. Type
// "User ID" is the employee's Emp_num directly -- verified live against
// [DB].[dbo].[PayEmp] (Comp_num=10): every User ID in a real export
// matched an existing Ittihad Emp_num, no translation table needed.
//
// Flow: upload -> parsed into per employee/day punches, upserted into the
// IttihadClockImportRows staging table (MySQL) for HR to review/edit ->
// confirm writes the reviewed in/out into TWO ERP tables (SQL Server, `erp`
// pool): [DB].[dbo].[TA_EmpTimeSheet] (the daily summary payroll reads,
// and what the "Daily Attendance Report" is built from) AND
// [DB].[dbo].[TA_ReadData] (raw per-punch rows -- one per IN, one per OUT
// -- which is what the ERP's own "Edit Time Clock" screen shows/edits;
// confirmed live by comparing against 4 rows a human had entered there by
// hand for EmpNo 710). Both need a row for a confirmed day to show up
// everywhere in the ERP a human would expect to see it.
// CompNo/SDate/EmpNo/Emp_IN/Emp_Out/Emp_INDT/Emp_OutDT are always
// populated on TA_EmpTimeSheet; ShiftNo/Prog_IN/Prog_Out/ShiftHrs/
// Daily_Prog are additionally filled in whenever the employee has a real
// shift assignment on file (see resolveIttihadShiftAssignments/
// getIttihadDailyPrograms) and left NULL otherwise -- never guessed from
// job title. That guess was tried once and was wrong live (EmpNo 349 got
// tagged Administration off its job title, "فني صيانة", when
// Ta_EmpCardInfo -- the ERP's own authoritative assignment table, and the
// same one TA_RptDailyAttendance INNER JOINs on -- says Factory).
import express from "express";
import multer from "multer";
import { Op } from "sequelize";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission, blockGmWrites } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { IttihadClockImportRow } from "../models/index.js";
import {
    resolveIttihadEmployeeNames,
    resolveIttihadShiftAssignments,
    getIttihadDailyPrograms,
    resolveIttihadSearchToEmpNos,
    to12hPadded,
    ITTIHAD_COMP_NO,
} from "../utils/ittihadEmployeeLookup.js";
import { resolveUserNames } from "../utils/userLookup.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticateToken, requirePermission(PERMISSIONS.HR_ITTIHAD_ATTENDANCE));
// Entirely an HR-admin tool (no self-service use, unlike hrRequests.js) --
// safe to block every non-GET method for gm at the router level.
router.use(blockGmWrites);

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize) || DEFAULT_PAGE_SIZE));
    return { page, pageSize };
}

// ============================================================
// Parsing: Realand RAMS export -> { empNo, workDate, time (HH:MM 24h), type }[]
// ============================================================
function parseRealandLog(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const punches = [];
    for (const line of lines) {
        const cols = line.split("\t").map((c) => c.trim()).filter((c) => c !== "");
        if (cols.length < 2) continue;
        const [userIdRaw, clockTimeRaw] = cols;
        const empNo = parseInt(userIdRaw, 10);
        if (!Number.isInteger(empNo)) continue; // skips the "User ID" header row
        // Realand exports come in two formats depending on the export
        // setting: "DD/MM/YYYY h:mm:ss AM/PM" (12h) or "DD/MM/YYYY HH:mm:ss"
        // (24h, no AM/PM suffix) -- both seen live from the same device.
        const m = clockTimeRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
        if (!m) continue;
        const [, dd, mm, yyyy, hStr, minStr, , ampm] = m;
        let hour = parseInt(hStr, 10);
        if (ampm) {
            hour %= 12;
            if (ampm.toUpperCase() === "PM") hour += 12;
        }
        const workDate = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
        const time = `${String(hour).padStart(2, "0")}:${minStr}`;
        punches.push({ empNo, workDate, time, type: cols[2] || "" });
    }
    return punches;
}

// ============================================================
// TA_ReadData (raw per-punch rows) -- what the ERP's "Edit Time Clock"
// screen shows/edits, separate from the TA_EmpTimeSheet daily summary.
// Mirrors Ta_ImportClock's own dedup pattern (delete-by-key then insert)
// so re-confirming/re-editing a day never leaves duplicate punch rows.
// ============================================================
async function writeTaReadDataPunch(pool, { compNo, empNo, workDate, time, keyF, shiftNo, userId }) {
    await pool.request()
        .input("compNo", compNo).input("empNo", empNo)
        .input("workDate", workDate).input("time", time)
        .query(`DELETE FROM [DB].[dbo].[TA_ReadData] WHERE CompNo=@compNo AND EmpNo=@empNo AND Day_Date=@workDate AND Day_Time=@time`);

    await pool.request()
        .input("compNo", compNo).input("empNo", empNo)
        .input("workDate", workDate).input("time", time)
        .input("cardNo", String(empNo))
        .input("keyF", keyF)
        .input("dateT", `${workDate}T${time}:00`)
        .input("shiftNo", shiftNo ?? null)
        .input("userId", userId ? String(userId).slice(0, 10) : null)
        .query(`
            INSERT INTO [DB].[dbo].[TA_ReadData] (CompNo, EmpNo, Day_Date, Day_Time, CardNo, KeyF, DateT, ShiftNo, ClockID, SysUpd, UserID, EntryDate)
            VALUES (@compNo, @empNo, @workDate, @time, @cardNo, @keyF, @dateT, @shiftNo, '0', 0, @userId, GETDATE())
        `);
}

async function deleteTaReadDataPunch(pool, { compNo, empNo, workDate, time }) {
    if (!time) return;
    await pool.request()
        .input("compNo", compNo).input("empNo", empNo)
        .input("workDate", workDate).input("time", time)
        .query(`DELETE FROM [DB].[dbo].[TA_ReadData] WHERE CompNo=@compNo AND EmpNo=@empNo AND Day_Date=@workDate AND Day_Time=@time`);
}

// ============================================================
// POST /import -- upload + parse a Realand export, upsert staging rows.
// ============================================================
router.post("/import", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    try {
        const text = req.file.buffer.toString("utf8");
        const punches = parseRealandLog(text);
        if (punches.length === 0) {
            return res.status(400).json({ success: false, message: "No valid punch rows found in the uploaded file" });
        }

        // Group by empNo+workDate.
        const groups = new Map(); // "empNo|workDate" -> punch[]
        for (const p of punches) {
            const key = `${p.empNo}|${p.workDate}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        }

        let created = 0, updated = 0, skippedPosted = 0, skippedEdited = 0;
        for (const [, group] of groups) {
            group.sort((a, b) => a.time.localeCompare(b.time));
            const { empNo, workDate } = group[0];
            const rawPunches = group.map((p) => ({ time: p.time, type: p.type }));

            const existing = await IttihadClockImportRow.findOne({ where: { empNo, workDate } });
            if (existing?.postedAt) { skippedPosted++; continue; }
            if (existing?.isEdited) {
                // Preserve HR's manual edit, just refresh the raw punch list
                // for reference.
                await existing.update({ rawPunches: JSON.stringify(rawPunches) });
                skippedEdited++;
                continue;
            }

            const inTime = group[0].time;
            const outTime = group.length > 1 ? group[group.length - 1].time : null;
            if (existing) {
                await existing.update({ inTime, outTime, rawPunches: JSON.stringify(rawPunches), importedByUserId: req.user.userId });
                updated++;
            } else {
                await IttihadClockImportRow.create({
                    empNo, workDate, inTime, outTime,
                    rawPunches: JSON.stringify(rawPunches),
                    importedByUserId: req.user.userId,
                });
                created++;
            }
        }

        res.json({ success: true, punchesParsed: punches.length, created, updated, skippedPosted, skippedEdited });
    } catch (err) {
        console.error("❌ ITTIHAD ATTENDANCE IMPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to import clock log" });
    }
});

// ============================================================
// GET / -- list staged rows (default: unposted only), newest first, paged.
// ============================================================
router.get("/", async (req, res) => {
    try {
        const { posted, dateFrom, dateTo, search } = req.query;
        const { page, pageSize } = parsePagination(req.query);

        const empNoFilter = await resolveIttihadSearchToEmpNos(search);
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, items: [], total: 0, page, pageSize });
        }

        const where = {};
        if (posted === "yes") where.postedAt = { [Op.ne]: null };
        else if (posted !== "all") where.postedAt = null; // default: pending review
        if (dateFrom || dateTo) {
            where.workDate = {};
            if (dateFrom) where.workDate[Op.gte] = dateFrom;
            if (dateTo) where.workDate[Op.lte] = dateTo;
        }
        if (empNoFilter) where.empNo = { [Op.in]: empNoFilter };

        const { rows, count } = await IttihadClockImportRow.findAndCountAll({
            where,
            order: [["workDate", "DESC"], ["empNo", "ASC"]],
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });
        const [empNames, userNames] = await Promise.all([
            resolveIttihadEmployeeNames(rows.map((r) => r.empNo)),
            resolveUserNames([
                ...rows.map((r) => r.importedByUserId),
                ...rows.map((r) => r.postedByUserId),
            ]),
        ]);

        const items = rows.map((r) => ({
            ...r.toJSON(),
            rawPunches: r.rawPunches ? JSON.parse(r.rawPunches) : [],
            employee: empNames[r.empNo] || null,
            importedBy: userNames[r.importedByUserId] || null,
            postedBy: r.postedByUserId ? (userNames[r.postedByUserId] || null) : null,
        }));

        res.json({ success: true, items, total: count, page, pageSize });
    } catch (err) {
        console.error("❌ ITTIHAD ATTENDANCE LIST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load staged attendance rows" });
    }
});

// ============================================================
// PATCH /:id -- HR edits the in/out time before confirming.
// ============================================================
router.patch("/:id", async (req, res) => {
    try {
        const row = await IttihadClockImportRow.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Row not found" });
        if (row.postedAt) return res.status(400).json({ success: false, message: "Already posted, can't be edited" });

        const { inTime, outTime } = req.body;
        const timeRe = /^\d{2}:\d{2}$/;
        if (inTime != null && inTime !== "" && !timeRe.test(inTime)) {
            return res.status(400).json({ success: false, message: "inTime must be HH:MM" });
        }
        if (outTime != null && outTime !== "" && !timeRe.test(outTime)) {
            return res.status(400).json({ success: false, message: "outTime must be HH:MM" });
        }

        await row.update({
            inTime: inTime === "" ? null : (inTime ?? row.inTime),
            outTime: outTime === "" ? null : (outTime ?? row.outTime),
            isEdited: true,
        });
        res.json({ success: true, row });
    } catch (err) {
        console.error("❌ ITTIHAD ATTENDANCE EDIT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update row" });
    }
});

// ============================================================
// DELETE /:id -- discard a staged row (e.g. a bad/duplicate reader punch).
// If the row was already posted, this also undoes both ERP writes confirm
// made: the TA_EmpTimeSheet summary (fully deletes the row if confirm
// INSERTed it fresh -- postedAsNewRow -- or only nulls back the specific
// fields confirm wrote if it UPDATEd a pre-existing row, never dropping a
// row we didn't create) and the raw TA_ReadData IN/OUT punches (always
// safe to delete outright -- those rows are never anything but ones we
// wrote, keyed by the exact time values this staging row held).
// ============================================================
router.delete("/:id", async (req, res) => {
    try {
        const row = await IttihadClockImportRow.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Row not found" });

        if (row.postedAt) {
            await withSqlRetry("erp", async (pool) => {
                if (row.postedAsNewRow) {
                    await pool.request()
                        .input("compNo", ITTIHAD_COMP_NO)
                        .input("sDate", row.workDate)
                        .input("empNo", row.empNo)
                        .query(`DELETE FROM [DB].[dbo].[TA_EmpTimeSheet] WHERE CompNo=@compNo AND SDate=@sDate AND EmpNo=@empNo`);
                } else {
                    const fields = [
                        "Emp_IN", "Emp_Out", "Emp_INDT", "Emp_OutDT",
                        "VacType", "Vacation", "Absence", "DayOff", "Reject",
                    ];
                    if (row.postedShiftFields) fields.push("ShiftNo", "Prog_IN", "Prog_Out", "ShiftHrs", "Daily_Prog");
                    const setClause = fields.map((f) => `${f}=NULL`).join(", ");
                    await pool.request()
                        .input("compNo", ITTIHAD_COMP_NO)
                        .input("sDate", row.workDate)
                        .input("empNo", row.empNo)
                        .query(`UPDATE [DB].[dbo].[TA_EmpTimeSheet] SET ${setClause} WHERE CompNo=@compNo AND SDate=@sDate AND EmpNo=@empNo`);
                }

                await deleteTaReadDataPunch(pool, { compNo: ITTIHAD_COMP_NO, empNo: row.empNo, workDate: row.workDate, time: row.inTime });
                await deleteTaReadDataPunch(pool, { compNo: ITTIHAD_COMP_NO, empNo: row.empNo, workDate: row.workDate, time: row.outTime });
            });
        }

        await row.destroy();
        res.json({ success: true, undone: !!row.postedAt });
    } catch (err) {
        console.error("❌ ITTIHAD ATTENDANCE DELETE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete row" });
    }
});

// ============================================================
// POST /confirm -- write the given (unposted) staged rows into
// TA_EmpTimeSheet, CompNo=10. Body: { ids: number[] }.
// ============================================================
router.post("/confirm", async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((n) => Number.isInteger(n)) : [];
    if (ids.length === 0) {
        return res.status(400).json({ success: false, message: "No rows selected" });
    }
    try {
        const rows = await IttihadClockImportRow.findAll({ where: { id: { [Op.in]: ids }, postedAt: null } });
        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: "None of the selected rows are pending" });
        }

        const empNos = rows.map((r) => r.empNo);
        const [employees, shiftAssignments, dailyPrograms, actorNames] = await Promise.all([
            resolveIttihadEmployeeNames(empNos),
            resolveIttihadShiftAssignments(empNos),
            getIttihadDailyPrograms(),
            resolveUserNames([req.user.userId]),
        ]);
        // TA_ReadData.UserID is varchar(10), same convention as the ERP's
        // own manual entries (e.g. 'fadi', 'AlaaHR') -- falls back to the
        // numeric userId if this login has no username on file.
        const actorUserId = actorNames[req.user.userId]?.username || String(req.user.userId);
        const posted = [];
        const invalidEmployee = [];

        for (const row of rows) {
            const employee = employees[row.empNo];
            if (!employee) {
                invalidEmployee.push({ id: row.id, empNo: row.empNo });
                continue;
            }

            const empIn = to12hPadded(row.inTime);
            const empOut = to12hPadded(row.outTime);
            const empInDt = row.inTime ? `${row.workDate}T${row.inTime}:00` : null;
            const empOutDt = row.outTime ? `${row.workDate}T${row.outTime}:00` : null;

            // ShiftNo comes straight from Ta_EmpCardInfo (the employee's
            // real assignment) and the schedule straight from
            // TA_DailyProgram keyed by that same ShiftNo as ProgID --
            // never guessed. If the employee has no card-info row on file,
            // shiftNo is undefined and ShiftNo/Prog_IN/Prog_Out/ShiftHrs/
            // Daily_Prog are left untouched (never included in the SET/
            // column list below) so an update never wipes out a value
            // entered some other way.
            const shiftNo = shiftAssignments[row.empNo];
            const schedule = shiftNo != null ? dailyPrograms[String(shiftNo)] : undefined;

            // Always force-clear the leave/absence flags: an UPDATE against
            // a row that already existed (e.g. an ERP-side placeholder)
            // otherwise leaves whatever was already there untouched, and a
            // stale VacType/Vacation/Absence/DayOff/Reject sitting next to
            // real Emp_IN/Emp_Out confuses the ERP's own attendance
            // reports into treating the day as leave instead of worked --
            // confirmed live: EmpNo 349's 2026-08-01 row had a leftover
            // VacType=3 from before our write and didn't show up in the
            // ERP's daily attendance view because of it.
            const fields = [
                "Emp_IN", "Emp_Out", "Emp_INDT", "Emp_OutDT",
                "VacType", "Vacation", "Absence", "DayOff", "Reject",
            ];
            const params = [
                "@empIn", "@empOut", "@empInDt", "@empOutDt",
                "@vacType", "@vacation", "@absence", "@dayOff", "@reject",
            ];
            if (schedule) {
                fields.push("ShiftNo", "Prog_IN", "Prog_Out", "ShiftHrs", "Daily_Prog");
                params.push("@shiftNo", "@progIn", "@progOut", "@shiftHrs", "@dailyProg");
            }

            let wasNewRow = false;
            await withSqlRetry("erp", async (pool) => {
                const existing = await pool.request()
                    .input("compNo", ITTIHAD_COMP_NO)
                    .input("sDate", row.workDate)
                    .input("empNo", row.empNo)
                    .query(`SELECT 1 FROM [DB].[dbo].[TA_EmpTimeSheet] WHERE CompNo=@compNo AND SDate=@sDate AND EmpNo=@empNo`);
                wasNewRow = existing.recordset.length === 0;

                const request = pool.request()
                    .input("compNo", ITTIHAD_COMP_NO)
                    .input("sDate", row.workDate)
                    .input("empNo", row.empNo)
                    .input("empIn", empIn)
                    .input("empOut", empOut)
                    .input("empInDt", empInDt)
                    .input("empOutDt", empOutDt)
                    .input("vacType", null)
                    .input("vacation", false)
                    .input("absence", false)
                    .input("dayOff", false)
                    .input("reject", false)
                    .input("shiftNo", schedule ? shiftNo : null)
                    .input("progIn", schedule ? schedule.progIn : null)
                    .input("progOut", schedule ? schedule.progOut : null)
                    .input("shiftHrs", schedule ? schedule.shiftHrs : null)
                    .input("dailyProg", schedule ? String(shiftNo) : null);

                if (existing.recordset.length > 0) {
                    const setClause = fields.map((f, i) => `${f}=${params[i]}`).join(", ");
                    await request.query(`
                        UPDATE [DB].[dbo].[TA_EmpTimeSheet]
                        SET ${setClause}
                        WHERE CompNo=@compNo AND SDate=@sDate AND EmpNo=@empNo
                    `);
                } else {
                    await request.query(`
                        INSERT INTO [DB].[dbo].[TA_EmpTimeSheet] (CompNo, SDate, EmpNo, ${fields.join(", ")})
                        VALUES (@compNo, @sDate, @empNo, ${params.join(", ")})
                    `);
                }

                // Raw punches for the "Edit Time Clock" screen -- separate
                // from the summary write above, see writeTaReadDataPunch.
                if (row.inTime) {
                    await writeTaReadDataPunch(pool, {
                        compNo: ITTIHAD_COMP_NO, empNo: row.empNo, workDate: row.workDate,
                        time: row.inTime, keyF: "IN", shiftNo, userId: actorUserId,
                    });
                }
                if (row.outTime) {
                    await writeTaReadDataPunch(pool, {
                        compNo: ITTIHAD_COMP_NO, empNo: row.empNo, workDate: row.workDate,
                        time: row.outTime, keyF: "OUT", shiftNo, userId: actorUserId,
                    });
                }
            });

            await row.update({
                postedAt: new Date(),
                postedByUserId: req.user.userId,
                postedAsNewRow: wasNewRow,
                postedShiftFields: !!schedule,
            });
            posted.push(row.id);
        }

        res.json({ success: true, posted: posted.length, invalidEmployee });
    } catch (err) {
        console.error("❌ ITTIHAD ATTENDANCE CONFIRM ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to post attendance to the ERP" });
    }
});

export default router;
