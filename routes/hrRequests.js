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
import { requirePermission } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import {
    HrLeaveRequest,
    HrAttendanceCorrectionRequest,
    HrAttendanceCorrectionRow,
    HrTransportRequest,
    HrTransportAccompanier,
} from "../models/index.js";
import { isSupervisorOf, getSupervisedEmpNos, hasRealSupervisor, getEmpNosWithoutRealSupervisor, getSupervisorUserId, getFallbackManagerUserIds } from "../utils/supervisorLookup.js";
import { isHrScopedRole, getHrQueueEmpNos, isInHrQueueScope, getHrReviewerUserIds, getFinanceReviewerUserIds } from "../utils/hrScope.js";
import { resolveEmployeeNames } from "../utils/employeeLookup.js";
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
const LEAVE_TYPES_REQUIRING_ATTACHMENT = new Set(["sick", "condolence_occasional"]);

function requireEmpNo(req, res) {
    if (!req.user.assignedEmpNo) {
        res.status(400).json({ success: false, message: "Your account isn't linked to a payroll record, so you can't submit HR requests." });
        return null;
    }
    return parseInt(req.user.assignedEmpNo);
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
                message: leaveType === "sick"
                    ? "A sick note attachment is required for sick leave"
                    : "A death certificate attachment is required for bereavement/occasional leave",
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

router.put("/leave-requests/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), async (req, res) => {
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

router.put("/attendance-corrections/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), async (req, res) => {
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
    if (transportMethod === "private_car" && kmDriven != null && (!Number.isFinite(Number(kmDriven)) || Number(kmDriven) < 0)) {
        return res.status(400).json({ success: false, message: "kmDriven must be a non-negative number" });
    }
    if (transportMethod === "public_transport" && farePaid != null && (!Number.isFinite(Number(farePaid)) || Number(farePaid) < 0)) {
        return res.status(400).json({ success: false, message: "farePaid must be a non-negative number" });
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

router.put("/transport-requests/:id/hr-decision", authenticateToken, requirePermission(PERMISSIONS.HR_REQUESTS_QUEUE), async (req, res) => {
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

router.put("/transport-requests/:id/finance-decision", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), async (req, res) => {
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
router.put("/transport-requests/:id/mark-paid", authenticateToken, requirePermission(PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE), async (req, res) => {
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
                message: leaveType === "sick"
                    ? "A sick note attachment is required for sick leave"
                    : "A death certificate attachment is required for bereavement/occasional leave",
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
    if (transportMethod === "private_car" && kmDriven != null && (!Number.isFinite(Number(kmDriven)) || Number(kmDriven) < 0)) {
        return res.status(400).json({ success: false, message: "kmDriven must be a non-negative number" });
    }
    if (transportMethod === "public_transport" && farePaid != null && (!Number.isFinite(Number(farePaid)) || Number(farePaid) < 0)) {
        return res.status(400).json({ success: false, message: "farePaid must be a non-negative number" });
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

// ============================================================
// GET /my-requests -- everything the caller submitted, all 3 types
// ============================================================
router.get("/my-requests", authenticateToken, async (req, res) => {
    try {
        const [leave, attendance, transport] = await Promise.all([
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
        ]);

        // Manager approver is an ERP empNo (like the requester); HR/Finance
        // reviewers and the payment confirmer are InsUser.userId (login
        // accounts, not necessarily linked to a payroll record) -- two
        // different lookups, same pattern as routes/hrReports.js.
        const [empNames, userNames, projectNames] = await Promise.all([
            resolveEmployeeNames([
                ...leave.map(r => r.managerApproverEmpNo),
                ...attendance.map(r => r.managerApproverEmpNo),
                ...transport.map(r => r.managerApproverEmpNo),
            ]),
            resolveUserNames([
                ...leave.map(r => r.hrReviewerUserId),
                ...attendance.map(r => r.hrReviewerUserId),
                ...transport.map(r => r.hrAuditorUserId),
                ...transport.map(r => r.financeApproverUserId),
                ...transport.map(r => r.paidByUserId),
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
        if (supervisedEmpNos && supervisedEmpNos.length === 0) {
            return res.json({ success: true, leave: [], attendance: [], transport: [] });
        }
        const where = supervisedEmpNos
            ? { status: "pending_manager", requesterEmpNo: supervisedEmpNos }
            : { status: "pending_manager" };

        const [leave, attendance, transport] = await Promise.all([
            HrLeaveRequest.findAll({ where, order: [["createdAt", "ASC"]] }),
            HrAttendanceCorrectionRequest.findAll({ where, order: [["createdAt", "ASC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            HrTransportRequest.findAll({ where, order: [["createdAt", "ASC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
        ]);
        const [names, projectNames] = await Promise.all([
            resolveEmployeeNames([...leave, ...attendance, ...transport].map(r => r.requesterEmpNo)),
            resolveProjectLabels(transport.map(r => r.projectLabel)),
        ]);
        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave", employee: names[r.requesterEmpNo] || null })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance", employee: names[r.requesterEmpNo] || null })),
            transport: transport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
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
// ============================================================
router.get("/manager-approvals-history", authenticateToken, async (req, res) => {
    try {
        const supervisedEmpNos = await getSupervisedEmpNosForCaller(req);
        if (supervisedEmpNos && supervisedEmpNos.length === 0) {
            return res.json({ success: true, leave: [], attendance: [], transport: [] });
        }
        const where = supervisedEmpNos
            ? { managerDecidedAt: { [Op.ne]: null }, requesterEmpNo: supervisedEmpNos }
            : { managerDecidedAt: { [Op.ne]: null } };

        const [leave, attendance, transport] = await Promise.all([
            HrLeaveRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]], limit: 100 }),
            HrAttendanceCorrectionRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]], limit: 100, include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            HrTransportRequest.findAll({ where, order: [["managerDecidedAt", "DESC"]], limit: 100, include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
        ]);
        const [empNames, userNames, projectNames] = await Promise.all([
            resolveEmployeeNames([...leave, ...attendance, ...transport].map(r => r.requesterEmpNo)),
            resolveUserNames([
                ...leave.map(r => r.hrReviewerUserId),
                ...attendance.map(r => r.hrReviewerUserId),
                ...transport.map(r => r.hrAuditorUserId),
                ...transport.map(r => r.financeApproverUserId),
            ]),
            resolveProjectLabels(transport.map(r => r.projectLabel)),
        ]);
        const withNames = (r, hrField) => ({
            employee: empNames[r.requesterEmpNo] || null,
            hrApprover: r[hrField] ? (userNames[r[hrField]] || null) : null,
        });
        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave", ...withNames(r, "hrReviewerUserId") })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance", ...withNames(r, "hrReviewerUserId") })),
            transport: transport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                ...withNames(r, "hrAuditorUserId"),
                financeApprover: r.financeApproverUserId ? (userNames[r.financeApproverUserId] || null) : null,
            })),
        });
    } catch (err) {
        console.error("❌ HR MANAGER APPROVALS HISTORY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch approvals history" });
    }
});

// ============================================================
// GET /am-i-a-supervisor -- cheap boolean check for whether this caller
// currently supervises anyone (or, for hr_manager, has anyone in their
// orphan fallback pool) -- backs client-side nav gating so the Approvals
// entry point only shows for people who'd actually see anything there.
// ============================================================
router.get("/am-i-a-supervisor", authenticateToken, async (req, res) => {
    try {
        const supervisedEmpNos = await getSupervisedEmpNosForCaller(req);
        res.json({ success: true, isSupervisor: supervisedEmpNos === null || supervisedEmpNos.length > 0 });
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
        const [leave, attendance, transport] = await Promise.all([
            HrLeaveRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]] }),
            HrAttendanceCorrectionRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            HrTransportRequest.findAll({ where: { status: "pending_hr_audit" }, order: [["createdAt", "ASC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
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
        const [names, projectNames] = await Promise.all([
            resolveEmployeeNames([...scopedLeave, ...scopedAttendance, ...scopedTransport].map(r => r.requesterEmpNo)),
            resolveProjectLabels(scopedTransport.map(r => r.projectLabel)),
        ]);
        res.json({
            success: true,
            leave: scopedLeave.map(r => ({ ...r.toJSON(), type: "leave", employee: names[r.requesterEmpNo] || null })),
            attendance: scopedAttendance.map(r => ({ ...r.toJSON(), type: "attendance", employee: names[r.requesterEmpNo] || null })),
            transport: scopedTransport.map(r => ({
                ...r.toJSON(),
                type: "transport",
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
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
