// backend/routes/hrReports.js
// Reporting/history views over the 3 HR request tables (see
// routes/hrRequests.js for the live submit/approve endpoints) -- for HR
// record-keeping and Accounting reconciliation, as opposed to the
// pending-only queues (hr-queue/manager-approvals/finance-queue).
//
// This is a pilot-phase feature (see backend/scripts/create-hr-tables.js)
// so row counts are modest -- reports fetch the full filtered set and
// paginate/aggregate in JS, mirroring glass.js's report convention of
// computing totals over the whole filtered set before slicing to a page,
// rather than adding SQL-level aggregation machinery for a table that
// doesn't need it yet.
import express from "express";
import { Op } from "sequelize";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import {
    HrLeaveRequest,
    HrAttendanceCorrectionRequest,
    HrAttendanceCorrectionRow,
    HrTransportRequest,
    HrTransportAccompanier,
} from "../models/index.js";
import { resolveEmployeeNames } from "../utils/employeeLookup.js";

const router = express.Router();

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize) || DEFAULT_PAGE_SIZE));
    return { page, pageSize };
}

// A free-text search resolves to a list of matching empNos up front (ERP
// names aren't in our MySQL tables), or a single exact empNo if the search
// term is purely numeric. Returns null if no search term was given (no
// filtering), or an array (possibly empty) otherwise.
async function resolveSearchToEmpNos(search) {
    if (!search) return null;
    const trimmed = String(search).trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return [parseInt(trimmed)];
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("search", `%${trimmed}%`)
        .query(`
            SELECT Emp_num FROM [DB].[dbo].[PayEmp]
            WHERE EmpName LIKE @search OR EmpEngName LIKE @search
        `));
    return result.recordset.map((r) => r.Emp_num);
}

function daysInLeave(r) {
    if (r.kind !== "leave" || !r.fromDate || !r.toDate) return 0;
    return Math.round((new Date(r.toDate) - new Date(r.fromDate)) / 86400000) + 1;
}

function countByStatus(rows) {
    return rows.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
    }, {});
}

// ============================================================
// GET /summary -- dashboard totals across all 3 request types. Visible to
// hr/admin (leave & attendance) and accounting/admin (transport totals).
// ============================================================
router.get("/summary", authenticateToken, authorizeRoles("hr", "admin", "accounting"), async (req, res) => {
    try {
        const now = new Date();
        const yearStart = `${now.getFullYear()}-01-01`;
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

        const [allLeave, allAttendance, allTransport] = await Promise.all([
            HrLeaveRequest.findAll(),
            HrAttendanceCorrectionRequest.findAll(),
            HrTransportRequest.findAll(),
        ]);

        const leaveDate = (r) => (r.kind === "leave" ? r.fromDate : r.createdAt.toISOString().slice(0, 10));
        const leaveThisYear = allLeave.filter((r) => leaveDate(r) >= yearStart);
        const leaveThisMonth = allLeave.filter((r) => leaveDate(r) >= monthStart);
        const attendanceDate = (r) => r.createdAt.toISOString().slice(0, 10);

        const sumApproved = (rows, field) => rows
            .filter((r) => r.status === "approved")
            .reduce((s, r) => s + (r[field] || 0), 0);

        res.json({
            success: true,
            leave: {
                byStatus: countByStatus(allLeave),
                approvedDaysThisMonth: leaveThisMonth
                    .filter((r) => r.status === "approved")
                    .reduce((s, r) => s + daysInLeave(r), 0),
                approvedDaysThisYear: leaveThisYear
                    .filter((r) => r.status === "approved")
                    .reduce((s, r) => s + daysInLeave(r), 0),
            },
            attendance: {
                byStatus: countByStatus(allAttendance),
                requestsThisMonth: allAttendance.filter((r) => attendanceDate(r) >= monthStart).length,
            },
            transport: {
                byStatus: countByStatus(allTransport),
                approvedKmThisMonth: sumApproved(allTransport.filter((r) => r.departureDate >= monthStart), "kmDriven"),
                approvedAmountThisMonth: sumApproved(allTransport.filter((r) => r.departureDate >= monthStart), "totalAmount"),
                approvedAmountThisYear: sumApproved(allTransport.filter((r) => r.departureDate >= yearStart), "totalAmount"),
            },
        });
    } catch (err) {
        console.error("❌ HR REPORTS SUMMARY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch HR reports summary" });
    }
});

// ============================================================
// GET /leave-attendance -- combined history of leave/departure and
// attendance-correction requests, for HR record-keeping.
// ============================================================
router.get("/leave-attendance", authenticateToken, authorizeRoles("hr", "admin"), async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { status, type, dateFrom, dateTo, search } = req.query;

        const empNoFilter = await resolveSearchToEmpNos(search);
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, items: [], total: 0, page, pageSize });
        }

        const where = {};
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };

        const [leave, attendance] = await Promise.all([
            (!type || type === "leave")
                ? HrLeaveRequest.findAll({ where, order: [["createdAt", "DESC"]] })
                : [],
            (!type || type === "attendance")
                ? HrAttendanceCorrectionRequest.findAll({
                    where,
                    order: [["createdAt", "DESC"]],
                    include: [{ model: HrAttendanceCorrectionRow, as: "rows" }],
                })
                : [],
        ]);

        let combined = [
            ...leave.map((r) => ({
                ...r.toJSON(),
                type: "leave",
                effectiveDate: r.kind === "leave" ? r.fromDate : r.createdAt.toISOString().slice(0, 10),
            })),
            ...attendance.map((r) => ({
                ...r.toJSON(),
                type: "attendance",
                effectiveDate: r.createdAt.toISOString().slice(0, 10),
            })),
        ];

        if (dateFrom) combined = combined.filter((r) => r.effectiveDate >= dateFrom);
        if (dateTo) combined = combined.filter((r) => r.effectiveDate <= dateTo);
        combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const names = await resolveEmployeeNames(combined.map((r) => r.requesterEmpNo));
        combined = combined.map((r) => ({ ...r, employee: names[r.requesterEmpNo] || null }));

        const total = combined.length;
        const items = combined.slice((page - 1) * pageSize, page * pageSize);
        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ HR LEAVE/ATTENDANCE REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch leave/attendance report" });
    }
});

// ============================================================
// GET /transport -- transport/reimbursement history, for Accounting
// reconciliation (also visible to hr/admin, who audit these before
// Finance signs off).
// ============================================================
router.get("/transport", authenticateToken, authorizeRoles("hr", "accounting", "admin"), async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { status, dateFrom, dateTo, search } = req.query;

        const empNoFilter = await resolveSearchToEmpNos(search);
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, items: [], total: 0, page, pageSize, totals: { count: 0, totalKm: 0, totalAmount: 0 } });
        }

        const where = {};
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };
        if (dateFrom || dateTo) {
            where.departureDate = {};
            if (dateFrom) where.departureDate[Op.gte] = dateFrom;
            if (dateTo) where.departureDate[Op.lte] = dateTo;
        }

        const transport = await HrTransportRequest.findAll({
            where,
            order: [["departureDate", "DESC"]],
            include: [{ model: HrTransportAccompanier, as: "accompaniers" }],
        });

        const names = await resolveEmployeeNames(transport.map((r) => r.requesterEmpNo));
        const enriched = transport.map((r) => ({ ...r.toJSON(), employee: names[r.requesterEmpNo] || null }));

        const total = enriched.length;
        const items = enriched.slice((page - 1) * pageSize, page * pageSize);
        const totals = {
            count: total,
            totalKm: enriched.reduce((s, r) => s + (r.kmDriven || 0), 0),
            totalAmount: enriched.reduce((s, r) => s + (r.totalAmount || 0), 0),
        };

        res.json({ success: true, items, total, page, pageSize, totals });
    } catch (err) {
        console.error("❌ HR TRANSPORT REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch transport report" });
    }
});

export default router;
