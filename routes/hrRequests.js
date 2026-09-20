// backend/routes/hrRequests.js
// Employee-Gate self-service HR requests -- digitized versions of paper
// forms HR 10-20 (leave/departure), HR 10-26 (attendance correction), and
// HR 10-34 (work departure / transportation allowance). See
// backend/scripts/create-hr-tables.js for the table-creation rationale:
// this is a standalone pilot phase, reading PayEmp.Supervisor_No/Vac_Bal
// live for approval routing and balance display, never writing to ERP.
//
// Approval routing: since PayEmp.Supervisor_No is a per-employee live
// value (not stored on the request), "is this caller the requester's
// manager" is re-checked against ERP on every manager-decision call
// rather than trusting a snapshot taken at submission time -- correct
// even if someone's supervisor changes between submission and review.
import express from "express";
import { Op } from "sequelize";
import multer from "multer";
import path from "path";
import fs from "fs";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { requirePermission, blockGmWrites } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import {
    HrLeaveRequest,
    HrAttendanceCorrectionRequest,
    HrAttendanceCorrectionRow,
    HrTransportRequest,
    HrTransportAccompanier,
    HrOvertimeRequest,
} from "../models/index.js";
import { isSupervisorOf, getSupervisedEmpNos, hasRealSupervisor, getEmpNosWithoutRealSupervisor, getSupervisorUserId, getFallbackManagerUserIds, isGeneralManager } from "../utils/supervisorLookup.js";
import { isHrScopedRole, getHrQueueEmpNos, isInHrQueueScope, getHrReviewerUserIds, getFinanceReviewerUserIds, getGmReviewerUserIds } from "../utils/hrScope.js";
import { resolveEmployeeNames, resolveVacationBalances } from "../utils/employeeLookup.js";
import { resolveUserNames } from "../utils/userLookup.js";
import { resolveProjectLabels, withProjectDisplay } from "../utils/projectLookup.js";
import { sendPushToUser } from "../services/pushNotifications.js";

const router = express.Router();

// Defense in depth for the 3 hr-decision endpoints below: GET /hr-queue
// already filters the LIST by scope, but a scoped HR role could otherwise
// still call PUT .../hr-decision directly with a known id belonging to a
// requester outside their scope. Returns true (allowed) for hr_manager/admin
// (unscoped) and for any HR-tier role whose scope actually covers this
// requester; false otherwise.
async function isHrDecisionInScope(role, requesterEmpNo) {
    if (!isHrScopedRole(role)) return true;
    return isInHrQueueScope(role, requesterEmpNo);
}

// Manager-decision authorization for the 3 endpoints below: the real
// supervisor (per PayEmp.Supervisor_No) or admin, same as always -- plus
// hr_manager as a fallback ONLY for employees who genuinely have no
// resolvable real supervisor (see hasRealSupervisor), so a request from a
// normal employee still can't be short-circuited by hr_manager past their
// actual manager.
// Best-effort notifications to whoever needs to act next at each stage --
// a missing account/device token should never block the request itself
// (same reasoning as sendPushToUser's own try/catch), so every call site
// below fires without awaiting and swallows its own errors.
async function notifyManagerOfNewRequest(requesterEmpNo, { title, body }) {
    try {
        const supervisorUserId = await getSupervisorUserId(requesterEmpNo);
        if (supervisorUserId) {
            sendPushToUser(supervisorUserId, { title, body });
            return;
        }
        // No resolvable real supervisor -- same hr_manager fallback as
        // isAuthorizedManagerDecision.
        const fallbackIds = await getFallbackManagerUserIds();
        fallbackIds.forEach((id) => sendPushToUser(id, { title, body }));
    } catch (err) {
        console.error("❌ Failed to notify manager of new request:", err);
    }
}

async function notifyHrReviewers(requesterEmpNo, { title, body }) {
    try {
        const reviewerIds = await getHrReviewerUserIds(requesterEmpNo);
        reviewerIds.forEach((id) => sendPushToUser(id, { title, body }));
    } catch (err) {
        console.error("❌ Failed to notify HR reviewers:", err);
    }
}

async function notifyFinanceReviewers({ title, body }) {
    try {
        const reviewerIds = await getFinanceReviewerUserIds();
        reviewerIds.forEach((id) => sendPushToUser(id, { title, body }));
    } catch (err) {
        console.error("❌ Failed to notify finance reviewers:", err);
    }
}

async function notifyGmReviewers({ title, body }) {
    try {
        const reviewerIds = await getGmReviewerUserIds();
        reviewerIds.forEach((id) => sendPushToUser(id, { title, body }));
    } catch (err) {
        console.error("❌ Failed to notify gm reviewers:", err);
    }
}

// Authorization for the overtime gm-decision stage -- same shape as
// isAuthorizedManagerDecision below (check the caller's own assignedEmpNo,
// admin bypass), except there's no Supervisor_No chain to walk: it's a
// live PayEmp check (Job_code=11, Comp_num=1 -- see isGeneralManager's
// comment) for whoever currently holds that job, not a role check.
async function isAuthorizedGmDecision(req) {
    if (req.user.role === "admin") return true;
    const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
    return await isGeneralManager(callerEmpNo);
}

// Resolves which requesterEmpNos this caller may see across
// /manager-approvals and /manager-approvals-history -- null means
// unscoped (admin). Shared so the hr_manager orphan-fallback logic isn't
// duplicated across both endpoints.
async function getSupervisedEmpNosForCaller(req) {
    const supervisorEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
    if (req.user.role === "admin") return null;
    let supervisedEmpNos = await getSupervisedEmpNos(supervisorEmpNo);
    // hr_manager also sees (and, per isAuthorizedManagerDecision above, may
    // approve) requests from employees who have no resolvable real
    // supervisor at all -- otherwise that fallback capability would only
    // be usable by guessing a request id.
    if (req.user.role === "hr_manager") {
        const orphanedEmpNos = await getEmpNosWithoutRealSupervisor();
        supervisedEmpNos = [...new Set([...supervisedEmpNos, ...orphanedEmpNos])];
    }
    return supervisedEmpNos;
}

async function isAuthorizedManagerDecision(req, requesterEmpNo) {
    if (req.user.role === "admin") return true;
    const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
    if (await isSupervisorOf(callerEmpNo, requesterEmpNo)) return true;
    if (req.user.role === "hr_manager" && !(await hasRealSupervisor(requesterEmpNo))) return true;
    return false;
}

// Sick-note / death-certificate attachment on a leave request -- mandatory
// for leaveType 'sick' and 'condolence_occasional' (enforced below),
// optional for every other type. Image or PDF, unlike the avatar upload
// (routes/upload.js), which is image-only. Mirrors that same
// disk-storage + fileFilter + size-limit pattern.
const attachmentsDir = path.resolve(process.cwd(), "uploads/hr-attachments");
fs.mkdirSync(attachmentsDir, { recursive: true });
const attachmentStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, attachmentsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
        const uniqueName = Date.now() + "-" + Math.random().toString(36).substring(2, 10) + ext;
        cb(null, uniqueName);
    },
});
const attachmentAllowedExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
const attachmentMimeRegex = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
const attachmentUpload = multer({
    storage: attachmentStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (attachmentMimeRegex.test(file.mimetype) && attachmentAllowedExts.has(ext)) {
            return cb(null, true);
        }
        return cb(new Error("Only image (JPG/PNG/WebP) or PDF attachments are allowed"));
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB -- documents scan larger than avatar photos
});
const LEAVE_TYPES_REQUIRING_ATTACHMENT = new Set(["sick", "condolence_occasional", "maternity_paternity"]);
const ATTACHMENT_REQUIRED_MESSAGE = {
    sick: "A sick note attachment is required for sick leave",
    condolence_occasional: "A death certificate attachment is required for bereavement/occasional leave",
    maternity_paternity: "A birth certificate attachment is required for maternity/paternity leave",
};

// Company rule: a departure (short personal-leave) request must cover more
// than 15 minutes -- exactly 15 (e.g. 08:00-08:15) is still rejected, 16+
// (08:00-08:16) is accepted. Confirmed live that most submitted departure
// requests land on fromTime "08:00" regardless of when the employee
// actually meant to leave (the mobile/web time picker opens to "now",
// which for a morning departure request is right around clock-in, and
// nobody bothers scrolling the wheel) -- so fromTime alone isn't trustworthy
// as the real start of the departure.
const MIN_DEPARTURE_MINUTES = 15;

// Real per-employee shift-start time for a given date, resolved the same
// way the ERP's own attendance system does: PayEmp -> that day's assigned
// program (TA_EmpTimeSheet.Daily_Prog) -> that program's scheduled clock-in
// (TA_DailyProgram.Prog_IN). Confirmed live for 100198 on ProgID 23
// ("وردية 8 الى 5"): Prog_IN "08:00" -- matches its real assigned schedule,
// not a guess. Returns null (falls back to trusting the client's fromTime
// as-is) if any link in that chain is missing for this employee/date.
async function getShiftStartMinutes(empNo, forDate) {
    // TA_EmpTimeSheet is populated by a nightly batch that lags behind --
    // confirmed live for 100198 it has no row at all for "today" (2026-08-24,
    // the exact date most departure requests are filed for), jumping
    // straight from the 23rd to the 26th. An exact SDate match would
    // therefore silently miss on the single most common case, so this
    // takes the most recent assigned program on or before the requested
    // date instead -- program assignments repeat/are stable day to day
    // (confirmed: 100198 was on ProgID 23 both the 20th and 23rd), so the
    // last known one is a reliable stand-in for a not-yet-generated today.
    const rows = await withSqlRetry("erp", (pool) => pool.request()
        .input("empNo", empNo)
        .input("forDate", forDate)
        .query(`
            SELECT TOP 1 dp.Prog_IN
            FROM dbo.PayEmp pe
            JOIN dbo.TA_EmpTimeSheet ts ON ts.CompNo = pe.Comp_num AND ts.EmpNo = pe.Emp_num AND ts.SDate <= @forDate
            JOIN dbo.TA_DailyProgram dp ON dp.CompNo = ts.CompNo AND dp.ProgID = ts.Daily_Prog
            WHERE pe.Emp_num = @empNo
            ORDER BY ts.SDate DESC
        `));
    const progIn = rows.recordset[0]?.Prog_IN;
    if (!progIn) return null;
    const [h, m] = String(progIn).trim().split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
}

// Returns null (not a rejection reason) when the request is valid, or a
// user-facing message when it isn't -- covers malformed "HH:MM" strings,
// a toTime at/before fromTime (confirmed live, 2026-08-24: 100198 typed a
// genuine noon-to-3pm departure as fromTime "12:00"/toTime "03:00" -- 3:00
// with no AM/PM concept in a 24h field means 03:00, not 15:00, giving a
// backwards/negative interval), and the MIN_DEPARTURE_MINUTES floor.
//
// That floor is deliberately NOT a blanket "every departure must be over
// 15 minutes" rule -- it only fires when fromTime is at or before the
// employee's real shift start (getShiftStartMinutes). That's the one
// specific pattern it exists to catch: the mobile/web time picker opens to
// "now", which for a morning submission is right around clock-in, and
// nobody bothers scrolling the wheel, so the request ends up claiming to
// start right at (or even before) the shift itself for a trivial gap. A
// clearly deliberate later-day departure (e.g. 12:00-15:00) never hits
// this floor at all, however short -- confirmed live this exact case was
// wrongly rejected before this fix, which is what prompted narrowing it.
async function departureDurationError(empNo, fromDate, fromTime, toTime) {
    const [fh, fm] = String(fromTime).split(":").map(Number);
    const [th, tm] = String(toTime).split(":").map(Number);
    if (![fh, fm, th, tm].every(Number.isFinite)) {
        return "fromTime and toTime must be in HH:MM format";
    }
    const fromMinutes = fh * 60 + fm;
    const toMinutes = th * 60 + tm;
    const rawDuration = toMinutes - fromMinutes;
    if (rawDuration <= 0) {
        return "Return time must be after the departure time -- check you didn't mix up AM/PM";
    }
    const shiftStartMinutes = await getShiftStartMinutes(empNo, fromDate);
    const startsAtOrBeforeShift = shiftStartMinutes != null && fromMinutes <= shiftStartMinutes;
    if (startsAtOrBeforeShift && rawDuration <= MIN_DEPARTURE_MINUTES) {
        return `A departure request must cover more than ${MIN_DEPARTURE_MINUTES} minutes`;
    }
    return null;
}

function requireEmpNo(req, res) {
    if (!req.user.assignedEmpNo) {
        res.status(400).json({ success: false, message: "Your account isn't linked to a payroll record, so you can't submit HR requests." });
        return null;
    }
    return parseInt(req.user.assignedEmpNo);
}

// Overtime requests (form 10-25) are restricted to the "100-series" of
// employee numbers -- same prefix convention as utils/hrScope.js's
// getEmpNosByPrefixGroup('100'), just checked directly against the
// already-known empNo (no live PayEmp lookup needed, unlike that helper --
// it exists to list an unknown SET of employees; here the one empNo is
// already in hand). A per-empNo rule, not a role -- the PermissionGrant
// system grants keys to roles, not individual employees, so this isn't
// expressible there and has to be a direct code check instead.
function isEligibleForOvertimeRequest(empNo) {
    return String(empNo).startsWith("100");
}

// ============================================================
// GET /vacation-balance -- read-only current annual-leave balance.
//
// CORRECTED (1st pass): this used to read PayEmp.Vac_Bal, which is dead --
// verified live that it's 0 for every one of the 527 active employees
// company-wide, not just the test account. The company's ERP has a full
// HR/payroll vacation module (Pay_Vac / Pay_VacBal / dozens of
// HRP_*/Pay_Vac* stored procs) that PayEmp.Vac_Bal was never wired up to.
//
// CORRECTED (2nd pass): Pay_VacBal.DueBal is the full-year figure (as if
// the whole year's entitlement had already accrued), not the balance as
// of today -- confirmed this reads noticeably higher than what's actually
// owed mid-year. The ERP's own HRP_GetVacBalance proc computes a proper
// as-of-date figure (its @RemBal output param), prorating OpeningBal
// linearly across the elapsed days of the year (from Jan 1, or hire date
// if hired this year, through today) before adding adjustments and
// RoundedBal and subtracting ConsBal (leave already taken/consumed). This
// is the ERP's own formula, reused as-is (per explicit direction) -- we
// can't call the proc directly, though: it passes @EmpNo into a smallint
// parameter slot of its own pay_GetAddSubVacs(@CompNo, @BalYear, @EmpNo,
// @EmpNo) call (confirmed via that function's real signature --
// (@CompNo, @pYear, @FVacType, @ToVac), i.e. a VacType *range*, not
// EmpNo x2) -- a genuine bug in the vendor SP that overflows for any
// EmpNo above 32767 (i.e. most active employees, verified live). So this
// replicates the same formula directly against Pay_VacBal/PayEmp/Pay_Vac/
// Pay_LevFreeHrsLog, using DATEDIFF in SQL (not JS Date math, to avoid
// timezone/DST rounding) -- verified against real employees (200231:
// full-year DueBal=34, as-of-today balance≈27.2).
router.get("/vacation-balance", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    try {
        const result = await withSqlRetry("erp", (pool) => pool.request()
            .input("empNo", empNo)
            .input("balYear", new Date().getFullYear())
            .query(`
                DECLARE @ToDate smalldatetime = GETDATE();
                SELECT
                    CASE WHEN pv.Vac_Bal = 1 THEN
                        (vb.OpeningBal *
                            CAST(DATEDIFF(day,
                                CASE WHEN pe.Apt_Date > CAST(@balYear AS varchar) + '-1-1' THEN pe.Apt_Date ELSE CAST(@balYear AS varchar) + '-1-1' END,
                                CASE WHEN pe.Work_status = 0 THEN pe.Work_status_Date ELSE @ToDate END
                            ) + 1 AS float)
                            /
                            CAST(DATEDIFF(day,
                                CASE WHEN pe.Apt_Date > CAST(@balYear AS varchar) + '-1-1' THEN pe.Apt_Date ELSE CAST(@balYear AS varchar) + '-1-1' END,
                                CAST(@balYear AS varchar) + '-12-31'
                            ) + 1 AS float)
                        )
                        + ISNULL((
                            SELECT SUM(Added_Hrs) FROM dbo.Pay_LevFreeHrsLog
                            WHERE CompNo = vb.CompNo AND EmpNo = vb.EmpNo AND Vac_Type = vb.VacType AND Upd_Year = vb.BalYear AND Trans_Type = 2
                        ), 0)
                        + vb.RoundedBal - vb.ConsBal
                    ELSE vb.DueBal END AS remainingBalance
                FROM dbo.Pay_VacBal vb
                INNER JOIN dbo.PayEmp pe ON vb.CompNo = pe.Comp_num AND vb.EmpNo = pe.Emp_num
                INNER JOIN dbo.Pay_Vac pv ON vb.CompNo = pv.CompNo AND vb.VacType = pv.Vac_Code
                WHERE vb.EmpNo = @empNo AND vb.VacType = 1 AND vb.BalYear = @balYear
            `));
        const balance = result.recordset[0]?.remainingBalance;
        res.json({ success: true, vacationBalance: balance != null ? Math.round(balance * 100) / 100 : null });
    } catch (err) {
        console.error("❌ HR VACATION BALANCE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch vacation balance" });
    }
});

// ============================================================
// GET /my-timesheet -- read-only monthly view of the caller's own daily
// attendance (scheduled shift + actual clock in/out + day-type flags),
// straight from TA_EmpTimeSheet -- the same table backend/routes/
// ittihadAttendance.js's confirm step writes to (that route is Ittihad/
// CompNo=10-only; this reads the same table company-wide, scoped to the
// caller's own EmpNo+CompNo). Deliberately no write endpoint here --
// fixing a wrong/missing punch is what Attendance Correction is for
// (POST /attendance-corrections below), not this view.
// ============================================================
router.get("/my-timesheet", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;

    const month = /^\d{4}-\d{2}$/.test(req.query.month || "")
        ? req.query.month
        : new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split("-").map(Number);
    const monthStart = `${month}-01`;
    // Day 0 of next month = last day of this month -- avoids hardcoding
    // 28/30/31 or leap-year logic.
    const monthEnd = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);

    try {
        const result = await withSqlRetry("erp", (pool) => pool.request()
            .input("empNo", empNo)
            .input("monthStart", monthStart)
            .input("monthEnd", monthEnd)
            .query(`
                SELECT t.SDate, t.Emp_IN, t.Emp_Out, t.Prog_IN, t.Prog_Out,
                       t.Absence, t.DayOff, t.Vacation, t.Reject,
                       t.ShiftHrs, t.Tot_Overt, t.Tot_Leaves
                FROM [DB].[dbo].[TA_EmpTimeSheet] t
                WHERE t.EmpNo = @empNo
                  AND t.CompNo = (SELECT Comp_num FROM [DB].[dbo].[PayEmp] WHERE Emp_num = @empNo)
                  AND t.SDate >= @monthStart AND t.SDate <= @monthEnd
                ORDER BY t.SDate ASC
            `));

        const days = result.recordset.map(r => ({
            date: r.SDate.toISOString().slice(0, 10),
            empIn: r.Emp_IN,
            empOut: r.Emp_Out,
            progIn: r.Prog_IN,
            progOut: r.Prog_Out,
            absence: !!r.Absence,
            dayOff: !!r.DayOff,
            vacation: !!r.Vacation,
            reject: !!r.Reject,
            shiftHrs: r.ShiftHrs,
            overtimeHrs: r.Tot_Overt,
            leaveHrs: r.Tot_Leaves,
        }));
        res.json({ success: true, month, days });
    } catch (err) {
        console.error("❌ HR MY TIMESHEET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch timesheet" });
    }
});

// ============================================================
// POST /leave-requests
// ============================================================
router.post("/leave-requests", authenticateToken, attachmentUpload.single("attachment"), async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    const { kind, fromTime, toTime, fromDate, toDate, leaveType, reason } = req.body;
    if (!["departure", "leave"].includes(kind)) {
        return res.status(400).json({ success: false, message: "kind must be 'departure' or 'leave'" });
    }
    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: "reason is required" });
    }
    if (kind === "departure") {
        if (!fromDate || !fromTime || !toTime) {
            return res.status(400).json({ success: false, message: "fromDate, fromTime, and toTime are required for a departure request" });
        }
        const durationError = await departureDurationError(empNo, fromDate, fromTime, toTime);
        if (durationError) {
            return res.status(400).json({ success: false, message: durationError });
        }
    } else {
        if (!fromDate || !toDate || !leaveType) {
            return res.status(400).json({ success: false, message: "fromDate, toDate, and leaveType are required for a leave request" });
        }
        if (new Date(toDate) < new Date(fromDate)) {
            return res.status(400).json({ success: false, message: "toDate cannot be before fromDate" });
        }
        if (LEAVE_TYPES_REQUIRING_ATTACHMENT.has(leaveType) && !req.file) {
            return res.status(400).json({
                success: false,
                message: ATTACHMENT_REQUIRED_MESSAGE[leaveType],
            });
        }
    }
    try {
        const request = await HrLeaveRequest.create({
            requesterUserId: req.user.userId,
            requesterEmpNo: empNo,
            kind,
            fromTime: fromTime || null,
            toTime: toTime || null,
            fromDate: fromDate || null,
            toDate: toDate || null,
            leaveType: leaveType || null,
            reason: reason || null,
            attachmentUrl: req.file ? `/uploads/hr-attachments/${req.file.filename}` : null,
            attachmentMimeType: req.file ? req.file.mimetype : null,
        });
        notifyManagerOfNewRequest(empNo, {
            title: kind === "departure" ? "New departure request" : "New leave request",
            body: "A request from your team needs your approval.",
        });
        res.json({ success: true, id: request.id });
    } catch (err) {
        console.error("❌ HR CREATE LEAVE REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to submit leave request" });
    }
});

router.put("/leave-requests/:id/manager-decision", authenticateToken, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrLeaveRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request is not awaiting manager review" });
        }
        const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        if (!(await isAuthorizedManagerDecision(req, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });
        }

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Leave request update",
            body: decision === "approved" ? "Your manager approved your leave request — now awaiting HR." : "Your manager rejected your leave request.",
        });
        if (decision === "approved") {
            notifyHrReviewers(request.requesterEmpNo, {
                title: "Leave request awaiting HR",
                body: "A manager-approved leave request needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR LEAVE MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/leave-requests/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrLeaveRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (!(await isHrDecisionInScope(req.user.role, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }
        if (request.status !== "pending_hr") {
            return res.status(400).json({ success: false, message: "This request is not awaiting HR review" });
        }
        await request.update({
            hrReviewerUserId: req.user.userId,
            hrDecision: decision,
            hrDecidedAt: new Date(),
            hrNote: note || null,
            status: decision,
        });
        sendPushToUser(request.requesterUserId, {
            title: "Leave request update",
            body: decision === "approved" ? "HR approved your leave request." : "HR rejected your leave request.",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR LEAVE HR DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

// ============================================================
// POST /attendance-corrections
// ============================================================
router.post("/attendance-corrections", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
        return res.status(400).json({ success: false, message: "At least one correction row is required" });
    }
    try {
        const request = await HrAttendanceCorrectionRequest.create({
            requesterUserId: req.user.userId,
            requesterEmpNo: empNo,
        });
        await HrAttendanceCorrectionRow.bulkCreate(rows.map(r => ({
            requestId: request.id,
            dayDate: r.dayDate,
            entryTime: r.entryTime || null,
            exitTime: r.exitTime || null,
            notes: r.notes || null,
        })));
        notifyManagerOfNewRequest(empNo, {
            title: "New attendance correction request",
            body: "A request from your team needs your approval.",
        });
        res.json({ success: true, id: request.id });
    } catch (err) {
        console.error("❌ HR CREATE ATTENDANCE CORRECTION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to submit attendance correction request" });
    }
});

router.put("/attendance-corrections/:id/manager-decision", authenticateToken, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrAttendanceCorrectionRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request is not awaiting manager review" });
        }
        const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        if (!(await isAuthorizedManagerDecision(req, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });
        }

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Attendance correction update",
            body: decision === "approved" ? "Your manager approved your attendance correction — now awaiting HR." : "Your manager rejected your attendance correction.",
        });
        if (decision === "approved") {
            notifyHrReviewers(request.requesterEmpNo, {
                title: "Attendance correction awaiting HR",
                body: "A manager-approved attendance correction needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR ATTENDANCE MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/attendance-corrections/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrAttendanceCorrectionRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (!(await isHrDecisionInScope(req.user.role, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }
        if (request.status !== "pending_hr") {
            return res.status(400).json({ success: false, message: "This request is not awaiting HR review" });
        }
        await request.update({
            hrReviewerUserId: req.user.userId,
            hrDecision: decision,
            hrDecidedAt: new Date(),
            hrNote: note || null,
            status: decision,
        });
        sendPushToUser(request.requesterUserId, {
            title: "Attendance correction update",
            body: decision === "approved" ? "HR approved your attendance correction." : "HR rejected your attendance correction.",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR ATTENDANCE HR DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

// Real-world data-integrity bug (confirmed live, 2026-08-24): both amount
// checks below used to only fire when the field was present at all
// ("!= null"), so omitting it entirely sailed through uncaught, leaving
// real transport-request rows with a null km/fare that make no sense for
// an actual trip. Now required whenever its transport method is selected.
// kmDriven must be a genuine positive number (0 km isn't a real private-car
// trip); farePaid allows 0 (a free ride is real -- shuttle, no charge,
// etc., corrected same day after first requiring > 0 for both).
function validateTransportAmount(transportMethod, kmDriven, farePaid) {
    if (transportMethod === "private_car") {
        if (kmDriven == null || !Number.isFinite(Number(kmDriven)) || Number(kmDriven) <= 0) {
            return "kmDriven is required and must be greater than 0 for a private car trip";
        }
    }
    if (transportMethod === "public_transport") {
        // 0 is a legitimate fare (a free ride -- shuttle, no charge, etc.),
        // unlike kmDriven above where 0 genuinely can't happen for a real
        // private-car trip -- explicit correction, 2026-08-24, after this
        // was first built to reject 0 the same way as null.
        if (farePaid == null || !Number.isFinite(Number(farePaid)) || Number(farePaid) < 0) {
            return "farePaid is required for public transport (0 is allowed for a free ride, but it can't be blank or negative)";
        }
    }
    return null;
}

// ============================================================
// POST /transport-requests
// ============================================================
router.post("/transport-requests", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    const {
        projectLabel, visitReason, departureDate, departureTime, returnTime,
        transportMethod, kmDriven, farePaid, accompaniers,
    } = req.body;
    if (!departureDate) {
        return res.status(400).json({ success: false, message: "departureDate is required" });
    }
    if (!["private_car", "public_transport"].includes(transportMethod)) {
        return res.status(400).json({ success: false, message: "transportMethod must be 'private_car' or 'public_transport'" });
    }
    const amountError = validateTransportAmount(transportMethod, kmDriven, farePaid);
    if (amountError) {
        return res.status(400).json({ success: false, message: amountError });
    }
    try {
        const request = await HrTransportRequest.create({
            requesterUserId: req.user.userId,
            requesterEmpNo: empNo,
            projectLabel: projectLabel || null,
            visitReason: visitReason || null,
            departureDate,
            departureTime: departureTime || null,
            returnTime: returnTime || null,
            transportMethod,
            kmDriven: transportMethod === "private_car" ? (kmDriven ?? null) : null,
            farePaid: transportMethod === "public_transport" ? (farePaid ?? null) : null,
        });
        const rows = Array.isArray(accompaniers) ? accompaniers : [];
        if (rows.length > 0) {
            await HrTransportAccompanier.bulkCreate(rows.map(r => ({
                requestId: request.id,
                empNo: r.empNo || null,
                name: r.name,
                reason: r.reason || null,
            })));
        }
        notifyManagerOfNewRequest(empNo, {
            title: "New transportation request",
            body: "A request from your team needs your approval.",
        });
        res.json({ success: true, id: request.id });
    } catch (err) {
        console.error("❌ HR CREATE TRANSPORT REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to submit transportation request" });
    }
});

router.put("/transport-requests/:id/manager-decision", authenticateToken, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request is not awaiting manager review" });
        }
        const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        if (!(await isAuthorizedManagerDecision(req, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });
        }

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr_audit" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Transportation request update",
            body: decision === "approved" ? "Your manager approved your transportation request — now awaiting HR audit." : "Your manager rejected your transportation request.",
        });
        if (decision === "approved") {
            notifyHrReviewers(request.requesterEmpNo, {
                title: "Transportation request awaiting HR audit",
                body: "A manager-approved transportation request needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/transport-requests/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (!(await isHrDecisionInScope(req.user.role, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }
        if (request.status !== "pending_hr_audit") {
            return res.status(400).json({ success: false, message: "This request is not awaiting HR audit" });
        }
        await request.update({
            hrAuditorUserId: req.user.userId,
            hrDecision: decision,
            hrDecidedAt: new Date(),
            hrNote: note || null,
            status: decision === "approved" ? "pending_finance" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Transportation request update",
            body: decision === "approved" ? "HR audited and approved your transportation request — now awaiting finance." : "HR rejected your transportation request.",
        });
        if (decision === "approved") {
            notifyFinanceReviewers({
                title: "Transportation request awaiting finance",
                body: "An HR-audited transportation request needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT HR DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/transport-requests/:id/finance-decision", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    const { decision, note, kmRate, additionalAmount, additionalAmountNote } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_finance") {
            return res.status(400).json({ success: false, message: "This request is not awaiting finance approval" });
        }

        let totalAmount = null;
        let appliedKmRate = null;
        // additionalAmount is a manual top-up Finance can add on top of the
        // km/fare calculation (bonus, correction, extra allowance) --
        // rounded to 3 decimals throughout to match JOD's fils (1/1000)
        // subunit convention.
        const appliedAdditionalAmount = additionalAmount != null ? parseFloat(additionalAmount) : null;
        if (decision === "approved") {
            if (request.transportMethod === "private_car") {
                if (kmRate == null) {
                    return res.status(400).json({ success: false, message: "kmRate is required to approve a private-car request" });
                }
                appliedKmRate = parseFloat(kmRate);
                totalAmount = (request.kmDriven || 0) * appliedKmRate;
            } else {
                totalAmount = request.farePaid || 0;
            }
            totalAmount = Math.round((totalAmount + (appliedAdditionalAmount || 0)) * 1000) / 1000;
        }

        await request.update({
            financeApproverUserId: req.user.userId,
            financeDecision: decision,
            financeDecidedAt: new Date(),
            financeNote: note || null,
            kmRate: appliedKmRate,
            additionalAmount: decision === "approved" ? appliedAdditionalAmount : null,
            additionalAmountNote: decision === "approved" ? (additionalAmountNote || null) : null,
            totalAmount,
            status: decision,
        });
        sendPushToUser(request.requesterUserId, {
            title: "Transportation request update",
            body: decision === "approved" ? "Finance approved your transportation request." : "Finance rejected your transportation request.",
        });
        res.json({ success: true, totalAmount });
    } catch (err) {
        console.error("❌ HR TRANSPORT FINANCE DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

// ============================================================
// PUT /transport-requests/:id/mark-paid -- Accounting's separate
// confirmation that an already-approved reimbursement was actually
// disbursed. Distinct from financeDecision ("approved" = amount signed
// off) since those are two different real-world events that can happen
// at different times (approval today, bank transfer next week).
// ============================================================
router.put("/transport-requests/:id/mark-paid", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "approved") {
            return res.status(400).json({ success: false, message: "Only approved requests can be marked as paid" });
        }
        if (request.paidAt) {
            return res.status(400).json({ success: false, message: "This request is already marked as paid" });
        }
        await request.update({ paidAt: new Date(), paidByUserId: req.user.userId });
        sendPushToUser(request.requesterUserId, {
            title: "Transportation request update",
            body: "Your transportation reimbursement has been paid.",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT MARK PAID ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to mark request as paid" });
    }
});

// ============================================================
router.post("/overtime-requests", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    if (!isEligibleForOvertimeRequest(empNo)) {
        return res.status(403).json({ success: false, message: "Overtime requests are only available to employees in the 100-series" });
    }
    const { date, workNature, otType, hours } = req.body;
    if (!date) {
        return res.status(400).json({ success: false, message: "date is required" });
    }
    if (!["weekday", "holiday"].includes(otType)) {
        return res.status(400).json({ success: false, message: "otType must be 'weekday' or 'holiday'" });
    }
    try {
        const request = await HrOvertimeRequest.create({
            requesterUserId: req.user.userId,
            requesterEmpNo: empNo,
            date,
            workNature: workNature || null,
            otType,
            hours: hours != null && hours !== "" ? Number(hours) : null,
        });
        notifyManagerOfNewRequest(empNo, {
            title: "New overtime request",
            body: "A request from your team needs your approval.",
        });
        res.json({ success: true, id: request.id });
    } catch (err) {
        console.error("❌ HR CREATE OVERTIME REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to submit overtime request" });
    }
});

router.put("/overtime-requests/:id/manager-decision", authenticateToken, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrOvertimeRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request is not awaiting manager review" });
        }
        const callerEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        if (!(await isAuthorizedManagerDecision(req, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });
        }

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_gm" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Overtime request update",
            body: decision === "approved" ? "Your manager approved your overtime request — now awaiting GM approval." : "Your manager rejected your overtime request.",
        });
        if (decision === "approved") {
            notifyGmReviewers({
                title: "Overtime request awaiting GM approval",
                body: "A manager-approved overtime request needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR OVERTIME MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

// PUT /overtime-requests/:id/gm-decision -- this form's "company
// management" signature stage. Authorized the same way as manager-decision
// (see isAuthorizedGmDecision above), not a role check.
router.put("/overtime-requests/:id/gm-decision", authenticateToken, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    if (!(await isAuthorizedGmDecision(req))) {
        return res.status(403).json({ success: false, message: "Only the General Manager can act on this stage" });
    }
    try {
        const request = await HrOvertimeRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending_gm") {
            return res.status(400).json({ success: false, message: "This request is not awaiting GM approval" });
        }
        await request.update({
            gmApproverUserId: req.user.userId,
            gmDecision: decision,
            gmDecidedAt: new Date(),
            gmNote: note || null,
            status: decision === "approved" ? "pending_hr" : "rejected",
        });
        sendPushToUser(request.requesterUserId, {
            title: "Overtime request update",
            body: decision === "approved" ? "The General Manager approved your overtime request — now awaiting HR." : "The General Manager rejected your overtime request.",
        });
        if (decision === "approved") {
            notifyHrReviewers(request.requesterEmpNo, {
                title: "Overtime request awaiting HR",
                body: "A GM-approved overtime request needs your review.",
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR OVERTIME GM DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/overtime-requests/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), blockGmWrites, async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrOvertimeRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (!(await isHrDecisionInScope(req.user.role, request.requesterEmpNo))) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }
        if (request.status !== "pending_hr") {
            return res.status(400).json({ success: false, message: "This request is not awaiting HR review" });
        }
        await request.update({
            hrReviewerUserId: req.user.userId,
            hrDecision: decision,
            hrDecidedAt: new Date(),
            hrNote: note || null,
            status: decision,
        });
        sendPushToUser(request.requesterUserId, {
            title: "Overtime request update",
            body: decision === "approved" ? "HR approved your overtime request." : "HR rejected your overtime request.",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR OVERTIME HR DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

// PUT /leave-requests/:id, /attendance-corrections/:id,
// /transport-requests/:id -- self-service edit. Requester-only, and only
// while still pending_manager -- stricter than cancel's window below,
// since once even the manager stage has acted, editing the content out
// from under a decision already made would be misleading. Reuses the
// exact same field validation as the matching POST create endpoint.
// ============================================================
router.put("/leave-requests/:id", authenticateToken, attachmentUpload.single("attachment"), async (req, res) => {
    const { kind, fromTime, toTime, fromDate, toDate, leaveType, reason } = req.body;
    if (!["departure", "leave"].includes(kind)) {
        return res.status(400).json({ success: false, message: "kind must be 'departure' or 'leave'" });
    }
    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: "reason is required" });
    }
    if (kind === "departure") {
        if (!fromDate || !fromTime || !toTime) {
            return res.status(400).json({ success: false, message: "fromDate, fromTime, and toTime are required for a departure request" });
        }
        const durationError = await departureDurationError(req.user.assignedEmpNo, fromDate, fromTime, toTime);
        if (durationError) {
            return res.status(400).json({ success: false, message: durationError });
        }
    } else {
        if (!fromDate || !toDate || !leaveType) {
            return res.status(400).json({ success: false, message: "fromDate, toDate, and leaveType are required for a leave request" });
        }
        if (new Date(toDate) < new Date(fromDate)) {
            return res.status(400).json({ success: false, message: "toDate cannot be before fromDate" });
        }
    }
    try {
        const request = await HrLeaveRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only edit your own requests" });
        }
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request has already entered review and can no longer be edited" });
        }
        if (kind === "leave" && LEAVE_TYPES_REQUIRING_ATTACHMENT.has(leaveType) && !req.file && !request.attachmentUrl) {
            return res.status(400).json({
                success: false,
                message: ATTACHMENT_REQUIRED_MESSAGE[leaveType],
            });
        }
        await request.update({
            kind,
            fromTime: fromTime || null,
            toTime: toTime || null,
            fromDate: fromDate || null,
            toDate: toDate || null,
            leaveType: leaveType || null,
            reason: reason || null,
            ...(req.file ? {
                attachmentUrl: `/uploads/hr-attachments/${req.file.filename}`,
                attachmentMimeType: req.file.mimetype,
            } : {}),
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR EDIT LEAVE REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update leave request" });
    }
});

router.put("/attendance-corrections/:id", authenticateToken, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
        return res.status(400).json({ success: false, message: "At least one correction row is required" });
    }
    try {
        const request = await HrAttendanceCorrectionRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only edit your own requests" });
        }
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request has already entered review and can no longer be edited" });
        }
        const t = await HrAttendanceCorrectionRequest.sequelize.transaction();
        try {
            await HrAttendanceCorrectionRow.destroy({ where: { requestId: request.id }, transaction: t });
            await HrAttendanceCorrectionRow.bulkCreate(rows.map(r => ({
                requestId: request.id,
                dayDate: r.dayDate,
                entryTime: r.entryTime || null,
                exitTime: r.exitTime || null,
                notes: r.notes || null,
            })), { transaction: t });
            await t.commit();
        } catch (txErr) {
            await t.rollback();
            throw txErr;
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR EDIT ATTENDANCE CORRECTION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update attendance correction request" });
    }
});

router.put("/transport-requests/:id", authenticateToken, async (req, res) => {
    const {
        projectLabel, visitReason, departureDate, departureTime, returnTime,
        transportMethod, kmDriven, farePaid, accompaniers,
    } = req.body;
    if (!departureDate) {
        return res.status(400).json({ success: false, message: "departureDate is required" });
    }
    if (!["private_car", "public_transport"].includes(transportMethod)) {
        return res.status(400).json({ success: false, message: "transportMethod must be 'private_car' or 'public_transport'" });
    }
    const amountError = validateTransportAmount(transportMethod, kmDriven, farePaid);
    if (amountError) {
        return res.status(400).json({ success: false, message: amountError });
    }
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only edit your own requests" });
        }
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request has already entered review and can no longer be edited" });
        }
        const t = await HrTransportRequest.sequelize.transaction();
        try {
            await request.update({
                projectLabel: projectLabel || null,
                visitReason: visitReason || null,
                departureDate,
                departureTime: departureTime || null,
                returnTime: returnTime || null,
                transportMethod,
                kmDriven: transportMethod === "private_car" ? (kmDriven ?? null) : null,
                farePaid: transportMethod === "public_transport" ? (farePaid ?? null) : null,
            }, { transaction: t });
            await HrTransportAccompanier.destroy({ where: { requestId: request.id }, transaction: t });
            const accompanierRows = Array.isArray(accompaniers) ? accompaniers : [];
            if (accompanierRows.length > 0) {
                await HrTransportAccompanier.bulkCreate(accompanierRows.map(r => ({
                    requestId: request.id,
                    empNo: r.empNo || null,
                    name: r.name,
                    reason: r.reason || null,
                })), { transaction: t });
            }
            await t.commit();
        } catch (txErr) {
            await t.rollback();
            throw txErr;
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR EDIT TRANSPORT REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update transportation request" });
    }
});

router.put("/overtime-requests/:id", authenticateToken, async (req, res) => {
    const { date, workNature, otType, hours } = req.body;
    if (!date) {
        return res.status(400).json({ success: false, message: "date is required" });
    }
    if (!["weekday", "holiday"].includes(otType)) {
        return res.status(400).json({ success: false, message: "otType must be 'weekday' or 'holiday'" });
    }
    try {
        const request = await HrOvertimeRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only edit your own requests" });
        }
        // Defense in depth -- submission is already blocked for non-100-
        // series accounts, so no existing request should ever fail this.
        if (!isEligibleForOvertimeRequest(request.requesterEmpNo)) {
            return res.status(403).json({ success: false, message: "Overtime requests are only available to employees in the 100-series" });
        }
        if (request.status !== "pending_manager") {
            return res.status(400).json({ success: false, message: "This request has already entered review and can no longer be edited" });
        }
        await request.update({
            date,
            workNature: workNature || null,
            otType,
            hours: hours != null && hours !== "" ? Number(hours) : null,
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR EDIT OVERTIME REQUEST ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update overtime request" });
    }
});

// ============================================================
// DELETE /leave-requests/:id, /attendance-corrections/:id,
// /transport-requests/:id -- self-service cancel. Requester-only, and only
// while the request is still awaiting a decision (a typo/change-of-mind
// fix); once any approve/reject decision has landed, canceling would erase
// a record someone already acted on, so it's blocked past that point.
// A soft status change (status='canceled', canceledAt set) rather than an
// actual row DELETE -- a canceled request stays visible on My HR Requests
// and in reports instead of vanishing without a trace. Kept on the DELETE
// verb/URL so no client (web or mobile) needed to change how it calls
// this. No route to un-cancel: withdrawing just means re-submitting a
// fresh request.
// ============================================================
router.delete("/leave-requests/:id", authenticateToken, async (req, res) => {
    try {
        const request = await HrLeaveRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only cancel your own requests" });
        }
        if (["approved", "rejected", "canceled"].includes(request.status)) {
            return res.status(400).json({ success: false, message: "This request has already been decided and can no longer be canceled" });
        }
        await request.update({ status: "canceled", canceledAt: new Date() });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR LEAVE CANCEL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to cancel request" });
    }
});

router.delete("/attendance-corrections/:id", authenticateToken, async (req, res) => {
    try {
        const request = await HrAttendanceCorrectionRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only cancel your own requests" });
        }
        if (["approved", "rejected", "canceled"].includes(request.status)) {
            return res.status(400).json({ success: false, message: "This request has already been decided and can no longer be canceled" });
        }
        await request.update({ status: "canceled", canceledAt: new Date() });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR ATTENDANCE CANCEL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to cancel request" });
    }
});

router.delete("/transport-requests/:id", authenticateToken, async (req, res) => {
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only cancel your own requests" });
        }
        if (["approved", "rejected", "canceled"].includes(request.status)) {
            return res.status(400).json({ success: false, message: "This request has already been decided and can no longer be canceled" });
        }
        await request.update({ status: "canceled", canceledAt: new Date() });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT CANCEL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to cancel request" });
    }
});

router.delete("/overtime-requests/:id", authenticateToken, async (req, res) => {
    try {
        const request = await HrOvertimeRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
        if (request.requesterUserId !== req.user.userId) {
            return res.status(403).json({ success: false, message: "You can only cancel your own requests" });
        }
        if (["approved", "rejected", "canceled"].includes(request.status)) {
            return res.status(400).json({ success: false, message: "This request has already been decided and can no longer be canceled" });
        }
        await request.update({ status: "canceled", canceledAt: new Date() });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR OVERTIME CANCEL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to cancel request" });
    }
});

// ============================================================
// GET /my-requests -- everything the caller submitted, all 4 types
// ============================================================
router.get("/my-requests", authenticateToken, async (req, res) => {
    try {
        const [leave, attendance, transport, overtime] = await Promise.all([
            HrLeaveRequest.findAll({ where: { requesterUserId: req.user.userId }, order: [["createdAt", "DESC"]] }),
            HrAttendanceCorrectionRequest.findAll({
                where: { requesterUserId: req.user.userId },
                order: [["createdAt", "DESC"]],
                include: [{ model: HrAttendanceCorrectionRow, as: "rows" }],
            }),
            HrTransportRequest.findAll({
                where: { requesterUserId: req.user.userId },
                order: [["createdAt", "DESC"]],
                include: [{ model: HrTransportAccompanier, as: "accompaniers" }],
            }),
            HrOvertimeRequest.findAll({
                where: { requesterUserId: req.user.userId },
                order: [["createdAt", "DESC"]],
            }),
        ]);

        // Manager approver is an ERP empNo (like the requester); HR/Finance/GM
        // reviewers and the payment confirmer are InsUser.userId (login
        // accounts, not necessarily linked to a payroll record) -- two
        // different lookups, same pattern as routes/hrReports.js.
        const [empNames, userNames, projectNames] = await Promise.all([
            resolveEmployeeNames([
                ...leave.map(r => r.managerApproverEmpNo),
                ...attendance.map(r => r.managerApproverEmpNo),
                ...transport.map(r => r.managerApproverEmpNo),
                ...overtime.map(r => r.managerApproverEmpNo),
            ]),
            resolveUserNames([
                ...leave.map(r => r.hrReviewerUserId),
                ...attendance.map(r => r.hrReviewerUserId),
                ...transport.map(r => r.hrAuditorUserId),
                ...transport.map(r => r.financeApproverUserId),
                ...transport.map(r => r.paidByUserId),
                ...overtime.map(r => r.gmApproverUserId),
                ...overtime.map(r => r.hrReviewerUserId),
            ]),
            resolveProjectLabels(transport.map(r => r.projectLabel)),
        ]);
        const approvers = (r, hrField) => ({
            managerApprover: r.managerApproverEmpNo ? (empNames[r.managerApproverEmpNo] || null) : null,
            hrApprover: r[hrField] ? (userNames[r[hrField]] || null) : null,
        });

        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave", ...approvers(r, "hrReviewerUserId") })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance", ...approvers(r, "hrReviewerUserId") })),
            transport: transport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                ...approvers(r, "hrAuditorUserId"),
                financeApprover: r.financeApproverUserId ? (userNames[r.financeApproverUserId] || null) : null,
                paidBy: r.paidByUserId ? (userNames[r.paidByUserId] || null) : null,
            })),
            overtime: overtime.map(r => ({
                ...r.toJSON(),
                type: "overtime",
                ...approvers(r, "hrReviewerUserId"),
                gmApprover: r.gmApproverUserId ? (userNames[r.gmApproverUserId] || null) : null,
            })),
        });
    } catch (err) {
        console.error("❌ HR MY REQUESTS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch your HR requests" });
    }
});

// ============================================================
// GET /manager-approvals -- pending_manager requests from anyone this
// caller supervises (data-driven, not role-gated -- anyone could be a
// supervisor per PayEmp.Supervisor_No)
// ============================================================
router.get("/manager-approvals", authenticateToken, async (req, res) => {
    try {
        const supervisedEmpNos = await getSupervisedEmpNosForCaller(req);
        const skipManagerStage = supervisedEmpNos && supervisedEmpNos.length === 0;
        const isGm = await isAuthorizedGmDecision(req);
        if (skipManagerStage && !isGm) {
            return res.json({ success: true, leave: [], attendance: [], transport: [], overtime: [] });
        }
        const where = supervisedEmpNos
            ? { status: "pending_manager", requesterEmpNo: supervisedEmpNos }
            : { status: "pending_manager" };

        const [leave, attendance, transport, overtime, overtimeGm] = await Promise.all([
            skipManagerStage ? [] : HrLeaveRequest.findAll({ where, order: [["createdAt", "ASC"]] }),
            skipManagerStage ? [] : HrAttendanceCorrectionRequest.findAll({ where, order: [["createdAt", "ASC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            skipManagerStage ? [] : HrTransportRequest.findAll({ where, order: [["createdAt", "ASC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
            skipManagerStage ? [] : HrOvertimeRequest.findAll({ where, order: [["createdAt", "ASC"]] }),
            // The GM stage isn't Supervisor_No-scoped like the rest of this
            // endpoint -- see isAuthorizedGmDecision -- so it's a flat,
            // unfiltered query gated purely on whether the caller IS the GM.
            isGm ? HrOvertimeRequest.findAll({ where: { status: "pending_gm" }, order: [["createdAt", "ASC"]] }) : [],
        ]);
        const combinedOvertime = [...overtime, ...overtimeGm];
        const [names, projectNames, vacationBalances] = await Promise.all([
            resolveEmployeeNames([...leave, ...attendance, ...transport, ...combinedOvertime].map(r => r.requesterEmpNo)),
            resolveProjectLabels(transport.map(r => r.projectLabel)),
            // Same as GET /hr-queue's own vacationBalance -- leave/departure
            // only, requested for the manager's approval card too now.
            resolveVacationBalances(leave.map(r => r.requesterEmpNo)),
        ]);
        res.json({
            success: true,
            leave: leave.map(r => ({
                ...r.toJSON(),
                type: "leave",
                employee: names[r.requesterEmpNo] || null,
                vacationBalance: vacationBalances[r.requesterEmpNo] ?? null,
            })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance", employee: names[r.requesterEmpNo] || null })),
            transport: transport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                employee: names[r.requesterEmpNo] || null,
            })),
            overtime: combinedOvertime.map(r => ({
                ...r.toJSON(),
                type: "overtime",
                employee: names[r.requesterEmpNo] || null,
            })),
        });
    } catch (err) {
        console.error("❌ HR MANAGER APPROVALS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch pending approvals" });
    }
});

// ============================================================
// GET /manager-approvals-history -- requests from anyone this caller
// supervises that they've already decided on (managerDecidedAt set),
// regardless of current downstream status, so a manager can see what
// they approved/rejected and where it stands now.
//
// Paginated (page/pageSize, same convention as routes/hrReports.js's
// parsePagination): the 3 request tables are fetched in full (no per-type
// limit -- was a flat limit:100 each, i.e. no real pagination, just a
// silent top-300 cutoff with no way to see anything older) and combined
// into one chronologically-sorted list before slicing, same
// fetch-all-then-combine-then-slice approach as hrReports.js's own
// GET /leave-attendance, since these 3 tables can't be paginated at the
// SQL level as one combined query (different tables, no UNION here).
// ============================================================
router.get("/manager-approvals-history", authenticateToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 30));

        const supervisedEmpNos = await getSupervisedEmpNosForCaller(req);
        const skipManagerStage = supervisedEmpNos && supervisedEmpNos.length === 0;
        const isGm = await isAuthorizedGmDecision(req);
        if (skipManagerStage && !isGm) {
            return res.json({ success: true, items: [], total: 0, page, pageSize });
        }
        const where = supervisedEmpNos
            ? { managerDecidedAt: { [Op.ne]: null }, requesterEmpNo: supervisedEmpNos }
            : { managerDecidedAt: { [Op.ne]: null } };

        const [leave, attendance, transport, overtime, overtimeGm] = await Promise.all([
            skipManagerStage ? [] : HrLeaveRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]] }),
            skipManagerStage ? [] : HrAttendanceCorrectionRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            skipManagerStage ? [] : HrTransportRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
            skipManagerStage ? [] : HrOvertimeRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]] }),
            // Not Supervisor_No-scoped -- see isAuthorizedGmDecision -- so
            // this is every overtime request the GM has ever decided on,
            // gated purely on whether the caller IS the GM.
            isGm ? HrOvertimeRequest.findAll({ where: { gmDecidedAt: { [Op.ne]: null } }, order: [["gmDecidedAt", "DESC"]] }) : [],
        ]);

        // callerStage marks which decision was actually the current
        // viewer's own -- for every type except overtime it's always
        // "manager" (the only stage this endpoint otherwise covers); for
        // overtime it can be either, since the same person is never both
        // the direct manager AND the GM on one request. sortDate picks the
        // matching timestamp so the two overtime buckets interleave
        // correctly instead of the GM-decided ones (often much later)
        // clumping at the wrong end of the list.
        let combined = [
            ...leave.map(r => ({ ...r.toJSON(), type: "leave", callerStage: "manager", sortDate: r.managerDecidedAt })),
            ...attendance.map(r => ({ ...r.toJSON(), type: "attendance", callerStage: "manager", sortDate: r.managerDecidedAt })),
            ...transport.map(r => ({ ...r.toJSON(), type: "transport", callerStage: "manager", sortDate: r.managerDecidedAt })),
            ...overtime.map(r => ({ ...r.toJSON(), type: "overtime", callerStage: "manager", sortDate: r.managerDecidedAt })),
            ...overtimeGm.map(r => ({ ...r.toJSON(), type: "overtime", callerStage: "gm", sortDate: r.gmDecidedAt })),
        ];
        combined.sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate));

        const total = combined.length;
        combined = combined.slice((page - 1) * pageSize, page * pageSize);

        const transportOnPage = combined.filter(r => r.type === "transport");
        const overtimeOnPage = combined.filter(r => r.type === "overtime");
        const [empNames, userNames, projectNames] = await Promise.all([
            resolveEmployeeNames(combined.map(r => r.requesterEmpNo)),
            resolveUserNames([
                ...combined.filter(r => r.type !== "transport" && r.type !== "overtime").map(r => r.hrReviewerUserId),
                ...transportOnPage.map(r => r.hrAuditorUserId),
                ...transportOnPage.map(r => r.financeApproverUserId),
                ...overtimeOnPage.map(r => r.hrReviewerUserId),
                ...overtimeOnPage.map(r => r.gmApproverUserId),
            ]),
            resolveProjectLabels(transportOnPage.map(r => r.projectLabel)),
        ]);
        const withNames = (r, hrField) => ({
            employee: empNames[r.requesterEmpNo] || null,
            hrApprover: r[hrField] ? (userNames[r[hrField]] || null) : null,
        });
        res.json({
            success: true,
            items: combined.map(r => {
                if (r.type === "transport") {
                    return {
                        ...r,
                        projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                        ...withNames(r, "hrAuditorUserId"),
                        financeApprover: r.financeApproverUserId ? (userNames[r.financeApproverUserId] || null) : null,
                    };
                }
                if (r.type === "overtime") {
                    return {
                        ...r,
                        ...withNames(r, "hrReviewerUserId"),
                        gmApprover: r.gmApproverUserId ? (userNames[r.gmApproverUserId] || null) : null,
                    };
                }
                return { ...r, ...withNames(r, "hrReviewerUserId") };
            }),
            total,
            page,
            pageSize,
        });
    } catch (err) {
        console.error("❌ HR MANAGER APPROVALS HISTORY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch approvals history" });
    }
});

// ============================================================
// GET /am-i-a-supervisor -- cheap boolean check for whether this caller
// currently supervises anyone (or, for hr_manager, has anyone in their
// orphan fallback pool), OR is the GM (isAuthorizedGmDecision) -- backs
// client-side nav gating so the Approvals entry point only shows for
// people who'd actually see anything there. The GM has no direct reports
// of their own in most cases, so without this OR they'd have no way to
// reach the overtime GM stage's approval UI at all (same page as manager
// approvals -- see GET /manager-approvals).
// ============================================================
router.get("/am-i-a-supervisor", authenticateToken, async (req, res) => {
    try {
        const supervisedEmpNos = await getSupervisedEmpNosForCaller(req);
        const isSupervisor = supervisedEmpNos === null || supervisedEmpNos.length > 0 || (await isAuthorizedGmDecision(req));
        res.json({ success: true, isSupervisor });
    } catch (err) {
        console.error("❌ HR AM I A SUPERVISOR ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to check supervisor status" });
    }
});

// ============================================================
// GET /hr-queue -- everything awaiting HR review, all 3 types
// ============================================================
router.get("/hr-queue", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), async (req, res) => {
    try {
        const [leave, attendance, transport, overtime] = await Promise.all([
            HrLeaveRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]] }),
            HrAttendanceCorrectionRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            HrTransportRequest.findAll({ where: { status: "pending_hr_audit" }, order: [["createdAt", "ASC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
            HrOvertimeRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]] }),
        ]);
        // hr_factory/hr_ittihad/hr are each scoped to a slice of the company
        // (see utils/hrScope.js) -- hr_manager (and admin, which never
        // reaches requirePermission's check) stay unscoped/company-wide as
        // the senior "sees everything" tier.
        let filterEmpNos = null;
        if (isHrScopedRole(req.user.role)) {
            filterEmpNos = new Set((await getHrQueueEmpNos(req.user.role)).map(Number));
        }
        const inScope = (r) => !filterEmpNos || filterEmpNos.has(Number(r.requesterEmpNo));
        const scopedLeave = leave.filter(inScope);
        const scopedAttendance = attendance.filter(inScope);
        const scopedTransport = transport.filter(inScope);
        const scopedOvertime = overtime.filter(inScope);
        const [names, projectNames, vacationBalances] = await Promise.all([
            resolveEmployeeNames([...scopedLeave, ...scopedAttendance, ...scopedTransport, ...scopedOvertime].map(r => r.requesterEmpNo)),
            resolveProjectLabels(scopedTransport.map(r => r.projectLabel)),
            // Leave/departure only -- an approver reviewing here benefits
            // from seeing the requester's remaining balance; attendance
            // corrections and transport reimbursements aren't leave-balance
            // decisions. Also attached on GET /manager-approvals now, same
            // reasoning.
            resolveVacationBalances(scopedLeave.map(r => r.requesterEmpNo)),
        ]);
        res.json({
            success: true,
            leave: scopedLeave.map(r => ({
                ...r.toJSON(),
                type: "leave",
                employee: names[r.requesterEmpNo] || null,
                vacationBalance: vacationBalances[r.requesterEmpNo] ?? null,
            })),
            attendance: scopedAttendance.map(r => ({ ...r.toJSON(), type: "attendance", employee: names[r.requesterEmpNo] || null })),
            transport: scopedTransport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                employee: names[r.requesterEmpNo] || null,
            })),
            overtime: scopedOvertime.map(r => ({
                ...r.toJSON(),
                type: "overtime",
                employee: names[r.requesterEmpNo] || null,
            })),
        });
    } catch (err) {
        console.error("❌ HR QUEUE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch HR queue" });
    }
});

// ============================================================
// GET /finance-queue -- transport requests awaiting finance approval
// ============================================================
router.get("/finance-queue", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), async (req, res) => {
    try {
        const transport = await HrTransportRequest.findAll({
            where: { status: "pending_finance" },
            order: [["createdAt", "ASC"]],
            include: [{ model: HrTransportAccompanier, as: "accompaniers" }],
        });
        const [names, projectNames] = await Promise.all([
            resolveEmployeeNames(transport.map(r => r.requesterEmpNo)),
            resolveProjectLabels(transport.map(r => r.projectLabel)),
        ]);
        res.json({
            success: true,
            transport: transport.map(r => ({
                ...r.toJSON(),
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                employee: names[r.requesterEmpNo] || null,
            })),
        });
    } catch (err) {
        console.error("❌ HR FINANCE QUEUE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch finance queue" });
    }
});

// ============================================================
// GET /finance-queue/employees -- every employee currently sitting in the
// finance queue, sorted, for its picker filter -- same "only offer
// employees actually in this view" reasoning as hrReports.js's /employees
// endpoints.
// ============================================================
router.get("/finance-queue/employees", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), async (req, res) => {
    try {
        const rows = await HrTransportRequest.findAll({
            where: { status: "pending_finance" },
            attributes: ["requesterEmpNo"],
        });
        const empNos = rows.map((r) => r.requesterEmpNo);
        const names = await resolveEmployeeNames(empNos);
        const data = [...new Set(empNos)]
            .filter((n) => names[n])
            .map((empNo) => ({
                empNo,
                name: names[empNo].name_ar || names[empNo].name_en || String(empNo),
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "ar"));
        res.json({ success: true, data });
    } catch (err) {
        console.error("❌ HR FINANCE QUEUE EMPLOYEES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch employee list" });
    }
});

export default router;
