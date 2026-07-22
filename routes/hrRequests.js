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
import { withSqlRetry } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import {
    HrLeaveRequest,
    HrAttendanceCorrectionRequest,
    HrAttendanceCorrectionRow,
    HrTransportRequest,
    HrTransportAccompanier,
} from "../models/index.js";
import { isSupervisorOf, getSupervisedEmpNos } from "../utils/supervisorLookup.js";

const router = express.Router();

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
// CORRECTED: this used to read PayEmp.Vac_Bal, which is dead -- verified
// live that it's 0 for every one of the 527 active employees company-wide,
// not just the test account. The company's ERP has a full HR/payroll
// vacation module (Pay_Vac / Pay_VacBal / dozens of HRP_*/Pay_Vac* stored
// procs) that PayEmp.Vac_Bal was never wired up to. Pay_VacBal is a
// proper per-employee, per-year, per-leave-type ledger (YearBal/
// OpeningBal/ConsBal/DueBal); Pay_Vac (the type lookup) confirms only
// Vac_Code=1 ("سنوية" / annual) has Vac_Bal=true -- every other leave
// type (sick, maternity, condolence, unpaid, ...) has no running balance
// concept in this company's configuration, matching the paper form's own
// emphasis on an annual-leave balance. DueBal for the current year is
// the "balance as of today" figure, confirmed against a real employee
// (200231): PayEmp.Vac_Bal read 0, Pay_VacBal's 2026 row read DueBal=34.
router.get("/vacation-balance", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    try {
        const result = await withSqlRetry("erp", (pool) => pool.request()
            .input("empNo", empNo)
            .input("balYear", new Date().getFullYear())
            .query(`
                SELECT DueBal FROM [DB].[dbo].[Pay_VacBal]
                WHERE EmpNo = @empNo AND VacType = 1 AND BalYear = @balYear
            `));
        res.json({ success: true, vacationBalance: result.recordset[0]?.DueBal ?? null });
    } catch (err) {
        console.error("❌ HR VACATION BALANCE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch vacation balance" });
    }
});

// ============================================================
// POST /leave-requests
// ============================================================
router.post("/leave-requests", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;
    const { kind, fromTime, toTime, fromDate, toDate, leaveType, reason } = req.body;
    if (!["departure", "leave"].includes(kind)) {
        return res.status(400).json({ success: false, message: "kind must be 'departure' or 'leave'" });
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
        const authorized = req.user.role === "admin" || await isSupervisorOf(callerEmpNo, request.requesterEmpNo);
        if (!authorized) return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr" : "rejected",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR LEAVE MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/leave-requests/:id/hr-decision", authenticateToken, authorizeRoles("hr", "admin"), async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrLeaveRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
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
        const authorized = req.user.role === "admin" || await isSupervisorOf(callerEmpNo, request.requesterEmpNo);
        if (!authorized) return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr" : "rejected",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR ATTENDANCE MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/attendance-corrections/:id/hr-decision", authenticateToken, authorizeRoles("hr", "admin"), async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrAttendanceCorrectionRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
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
        const authorized = req.user.role === "admin" || await isSupervisorOf(callerEmpNo, request.requesterEmpNo);
        if (!authorized) return res.status(403).json({ success: false, message: "You are not this employee's supervisor" });

        await request.update({
            managerApproverEmpNo: callerEmpNo,
            managerDecision: decision,
            managerDecidedAt: new Date(),
            managerNote: note || null,
            status: decision === "approved" ? "pending_hr_audit" : "rejected",
        });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT MANAGER DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/transport-requests/:id/hr-decision", authenticateToken, authorizeRoles("hr", "admin"), async (req, res) => {
    const { decision, note } = req.body;
    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ success: false, message: "decision must be 'approved' or 'rejected'" });
    }
    try {
        const request = await HrTransportRequest.findByPk(req.params.id);
        if (!request) return res.status(404).json({ success: false, message: "Request not found" });
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
        res.json({ success: true });
    } catch (err) {
        console.error("❌ HR TRANSPORT HR DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
    }
});

router.put("/transport-requests/:id/finance-decision", authenticateToken, authorizeRoles("accounting", "admin"), async (req, res) => {
    const { decision, note, kmRate } = req.body;
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
        if (decision === "approved") {
            if (request.transportMethod === "private_car") {
                if (kmRate == null) {
                    return res.status(400).json({ success: false, message: "kmRate is required to approve a private-car request" });
                }
                appliedKmRate = parseFloat(kmRate);
                totalAmount = Math.round((request.kmDriven || 0) * appliedKmRate * 1000) / 1000;
            } else {
                totalAmount = request.farePaid || 0;
            }
        }

        await request.update({
            financeApproverUserId: req.user.userId,
            financeDecision: decision,
            financeDecidedAt: new Date(),
            financeNote: note || null,
            kmRate: appliedKmRate,
            totalAmount,
            status: decision,
        });
        res.json({ success: true, totalAmount });
    } catch (err) {
        console.error("❌ HR TRANSPORT FINANCE DECISION ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to record decision" });
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
        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave" })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance" })),
            transport: transport.map(r => ({ ...r.toJSON(), type: "transport" })),
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
        const supervisorEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
        const supervisedEmpNos = req.user.role === "admin" ? null : await getSupervisedEmpNos(supervisorEmpNo);
        if (req.user.role !== "admin" && supervisedEmpNos.length === 0) {
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
        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave" })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance" })),
            transport: transport.map(r => ({ ...r.toJSON(), type: "transport" })),
        });
    } catch (err) {
        console.error("❌ HR MANAGER APPROVALS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch pending approvals" });
    }
});

// ============================================================
// GET /hr-queue -- everything awaiting HR review, all 3 types
// ============================================================
router.get("/hr-queue", authenticateToken, authorizeRoles("hr", "admin"), async (req, res) => {
    try {
        const [leave, attendance, transport] = await Promise.all([
            HrLeaveRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]] }),
            HrAttendanceCorrectionRequest.findAll({ where: { status: "pending_hr" }, order: [["createdAt", "ASC"]], include: [{ model: HrAttendanceCorrectionRow, as: "rows" }] }),
            HrTransportRequest.findAll({ where: { status: "pending_hr_audit" }, order: [["createdAt", "ASC"]], include: [{ model: HrTransportAccompanier, as: "accompaniers" }] }),
        ]);
        res.json({
            success: true,
            leave: leave.map(r => ({ ...r.toJSON(), type: "leave" })),
            attendance: attendance.map(r => ({ ...r.toJSON(), type: "attendance" })),
            transport: transport.map(r => ({ ...r.toJSON(), type: "transport" })),
        });
    } catch (err) {
        console.error("❌ HR QUEUE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch HR queue" });
    }
});

// ============================================================
// GET /finance-queue -- transport requests awaiting finance approval
// ============================================================
router.get("/finance-queue", authenticateToken, authorizeRoles("accounting", "admin"), async (req, res) => {
    try {
        const transport = await HrTransportRequest.findAll({
            where: { status: "pending_finance" },
            order: [["createdAt", "ASC"]],
            include: [{ model: HrTransportAccompanier, as: "accompaniers" }],
        });
        res.json({ success: true, transport: transport.map(r => r.toJSON()) });
    } catch (err) {
        console.error("❌ HR FINANCE QUEUE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch finance queue" });
    }
});

export default router;
