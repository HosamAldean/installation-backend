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
import { resolveEmployeeNames } from "../utils/employeeLookup.js";
import { resolveUserNames } from "../utils/userLookup.js";
import { isHrScopedRole, getHrScopedEmpNos, getEmpNosByPrefixGroup } from "../utils/hrScope.js";
import { resolveProjectLabels, withProjectDisplay } from "../utils/projectLookup.js";

const router = express.Router();

// hr_factory/hr_ittihad/hr are each scoped to a slice of the company for
// reports (see utils/hrScope.js). accounting/accounting_manager/hr_manager/
// admin aren't HR-tier roles in that map, so this returns null (no
// filtering) for them, same as before this redesign.
async function hrReportScopeFilter(role) {
    if (!isHrScopedRole(role)) return null;
    return new Set((await getHrScopedEmpNos(role)).map(Number));
}

// Optional display-only slice by Emp_num prefix "100" vs everyone else --
// not a role/scope boundary (see getEmpNosByPrefixGroup's own comment),
// just a way to view either half of a report on demand. Returns null if
// the caller didn't ask for a split.
async function empGroupFilter(empGroup) {
    if (empGroup !== '100' && empGroup !== 'other') return null;
    return new Set((await getEmpNosByPrefixGroup(empGroup)).map(Number));
}

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

// Shared by the two /employees list endpoints below -- resolves a set of
// requesterEmpNos to sorted {empNo, name} display pairs for the report
// filter bars' employee picker. Unlike resolveSearchToEmpNos above (which
// answers "does this filter value match any employee"), this lists only
// employees who actually have a row in the report being viewed, so the
// picker never offers someone with nothing to filter to.
async function sortedEmployeeList(empNos) {
    const names = await resolveEmployeeNames(empNos);
    return [...new Set(empNos)]
        .filter((n) => names[n])
        .map((empNo) => ({
            empNo,
            name: names[empNo].name_ar || names[empNo].name_en || String(empNo),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

// ============================================================
// GET /transport/employees -- every employee with a transport request,
// for the Transport tab's picker. Unscoped, matching GET /transport
// itself (see that route's comment on why).
// ============================================================
router.get("/transport/employees", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_TRANSPORT), async (req, res) => {
    try {
        const rows = await HrTransportRequest.findAll({ attributes: ["requesterEmpNo"] });
        res.json({ success: true, data: await sortedEmployeeList(rows.map((r) => r.requesterEmpNo)) });
    } catch (err) {
        console.error("❌ HR TRANSPORT EMPLOYEES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch employee list" });
    }
});

// ============================================================
// GET /leave-attendance/employees -- every employee with a leave or
// attendance-correction request, scoped the same way GET /leave-attendance
// itself is (an HR-tier role's picker only offers employees in their own
// scope).
// ============================================================
router.get("/leave-attendance/employees", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE), async (req, res) => {
    try {
        const scopeFilter = await hrReportScopeFilter(req.user.role);
        const [leave, attendance] = await Promise.all([
            HrLeaveRequest.findAll({ attributes: ["requesterEmpNo"] }),
            HrAttendanceCorrectionRequest.findAll({ attributes: ["requesterEmpNo"] }),
        ]);
        let empNos = [...leave, ...attendance].map((r) => r.requesterEmpNo);
        if (scopeFilter) empNos = empNos.filter((n) => scopeFilter.has(Number(n)));
        res.json({ success: true, data: await sortedEmployeeList(empNos) });
    } catch (err) {
        console.error("❌ HR LEAVE/ATTENDANCE EMPLOYEES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch employee list" });
    }
});

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
// GET /summary -- dashboard totals across all 3 request types (the
// Summary tab). Gated on its own key, split from the Transport tab's --
// see PERMISSIONS.HR_REPORTS_SUMMARY/HR_REPORTS_TRANSPORT.
// ============================================================
router.get("/summary", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_SUMMARY), async (req, res) => {
    try {
        const now = new Date();
        const yearStart = `${now.getFullYear()}-01-01`;
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

        const scopeFilter = await hrReportScopeFilter(req.user.role);
        const inScope = (r) => !scopeFilter || scopeFilter.has(Number(r.requesterEmpNo));

        const [allLeaveAndDeparture, allAttendance, allTransport] = await Promise.all([
            HrLeaveRequest.findAll().then((rows) => rows.filter(inScope)),
            HrAttendanceCorrectionRequest.findAll().then((rows) => rows.filter(inScope)),
            HrTransportRequest.findAll().then((rows) => rows.filter(inScope)),
        ]);
        // HrLeaveRequest covers both full-day leave (kind='leave') and
        // partial-day work departure (kind='departure', Form 10-20's other
        // half) -- split apart here so each gets its own breakdown instead
        // of being silently combined into one "leave" bucket.
        const allLeave = allLeaveAndDeparture.filter((r) => r.kind === "leave");
        const allDeparture = allLeaveAndDeparture.filter((r) => r.kind === "departure");

        const leaveThisYear = allLeave.filter((r) => r.fromDate >= yearStart);
        const leaveThisMonth = allLeave.filter((r) => r.fromDate >= monthStart);
        // fromDate wasn't collected for departures before this was added --
        // older rows fall back to createdAt, new ones use the actual date
        // the employee picked.
        const departureDate = (r) => r.fromDate || r.createdAt.toISOString().slice(0, 10);
        const departureThisYear = allDeparture.filter((r) => departureDate(r) >= yearStart);
        const departureThisMonth = allDeparture.filter((r) => departureDate(r) >= monthStart);
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
            departure: {
                byStatus: countByStatus(allDeparture),
                // Departures are partial-day (fromTime/toTime), not a whole
                // day off, so "approved count" is the meaningful figure
                // here rather than a day total.
                approvedCountThisMonth: departureThisMonth.filter((r) => r.status === "approved").length,
                approvedCountThisYear: departureThisYear.filter((r) => r.status === "approved").length,
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
router.get("/leave-attendance", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE), async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { status, type, dateFrom, dateTo, search, exported, empGroup } = req.query;

        let empNoFilter = await resolveSearchToEmpNos(search);
        const scopeFilter = await hrReportScopeFilter(req.user.role);
        const groupFilter = await empGroupFilter(empGroup);
        for (const filter of [scopeFilter, groupFilter]) {
            if (!filter) continue;
            // Intersect with the free-text search filter (and each other)
            // if given, rather than letting any one alone widen the result
            // past this role's actual scope.
            empNoFilter = empNoFilter
                ? empNoFilter.filter((n) => filter.has(Number(n)))
                : [...filter];
        }
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, items: [], total: 0, page, pageSize });
        }

        const where = {};
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };
        // Defaults to unset (no filter) unless the caller explicitly asks --
        // the report page itself defaults its own UI to "no" so a fresh
        // export naturally only grabs new records, see mark-exported below.
        if (exported === "no") where.exportedAt = null;
        else if (exported === "yes") where.exportedAt = { [Op.ne]: null };

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
                // fromDate wasn't collected for departures before this was
                // added -- older rows fall back to createdAt.
                effectiveDate: r.fromDate || r.createdAt.toISOString().slice(0, 10),
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

        // Manager approver is an ERP empNo (like the requester); HR reviewer
        // is an InsUser.userId (HR staff are login accounts, not
        // necessarily linked to a payroll record) -- two different lookups.
        const [empNames, userNames] = await Promise.all([
            resolveEmployeeNames([
                ...combined.map((r) => r.requesterEmpNo),
                ...combined.map((r) => r.managerApproverEmpNo),
            ]),
            resolveUserNames(combined.map((r) => r.hrReviewerUserId)),
        ]);
        combined = combined.map((r) => ({
            ...r,
            employee: empNames[r.requesterEmpNo] || null,
            managerApprover: r.managerApproverEmpNo ? (empNames[r.managerApproverEmpNo] || null) : null,
            hrApprover: r.hrReviewerUserId ? (userNames[r.hrReviewerUserId] || null) : null,
        }));

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
// Finance signs off). Own key, split from the Summary tab's -- see
// PERMISSIONS.HR_REPORTS_SUMMARY/HR_REPORTS_TRANSPORT.
// ============================================================
router.get("/transport", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_TRANSPORT), async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { status, dateFrom, dateTo, search, paidStatus, exported, empGroup } = req.query;

        // Unlike Summary/Leave-Attendance, the Transport tab is deliberately
        // company-wide for every role holding HR_REPORTS_TRANSPORT (hr/
        // hr_factory/hr_ittihad included) -- Accounting always saw it
        // unscoped (not an HR-tier role per hrReportScopeFilter), and HR
        // needs the same full view to reconcile transport reimbursements
        // against Accounting rather than a department-limited slice.
        let empNoFilter = await resolveSearchToEmpNos(search);
        const groupFilter = await empGroupFilter(empGroup);
        for (const filter of [groupFilter]) {
            if (!filter) continue;
            empNoFilter = empNoFilter
                ? empNoFilter.filter((n) => filter.has(Number(n)))
                : [...filter];
        }
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, items: [], total: 0, page, pageSize, totals: { count: 0, totalKm: 0, totalAmount: 0, totalPaid: 0, totalUnpaid: 0 } });
        }

        const where = {};
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };
        if (dateFrom || dateTo) {
            where.departureDate = {};
            if (dateFrom) where.departureDate[Op.gte] = dateFrom;
            if (dateTo) where.departureDate[Op.lte] = dateTo;
        }
        // "Paid" vs "not paid" is a simple paidAt split, not restricted to
        // approved requests -- "not paid" covers everything still owed or
        // pending (approved-but-unpaid, plus anything still in review),
        // so the two buckets are exhaustive and never lose a row between
        // them. Only approved requests can ever actually have paidAt set
        // (see the mark-paid endpoint in hrRequests.js).
        if (paidStatus === "paid") {
            where.paidAt = { [Op.ne]: null };
        } else if (paidStatus === "unpaid") {
            where.paidAt = null;
        }
        if (exported === "no") where.exportedAt = null;
        else if (exported === "yes") where.exportedAt = { [Op.ne]: null };

        const transport = await HrTransportRequest.findAll({
            where,
            order: [["departureDate", "DESC"]],
            include: [{ model: HrTransportAccompanier, as: "accompaniers" }],
        });

        const [empNames, userNames, projectNames] = await Promise.all([
            resolveEmployeeNames([
                ...transport.map((r) => r.requesterEmpNo),
                ...transport.map((r) => r.managerApproverEmpNo),
            ]),
            resolveUserNames([
                ...transport.map((r) => r.hrAuditorUserId),
                ...transport.map((r) => r.financeApproverUserId),
                ...transport.map((r) => r.paidByUserId),
            ]),
            resolveProjectLabels(transport.map((r) => r.projectLabel)),
        ]);
        const enriched = transport.map((r) => {
            return {
                ...r.toJSON(),
                projectLabel: withProjectDisplay(r.projectLabel, projectNames),
                employee: empNames[r.requesterEmpNo] || null,
                managerApprover: r.managerApproverEmpNo ? (empNames[r.managerApproverEmpNo] || null) : null,
                hrApprover: r.hrAuditorUserId ? (userNames[r.hrAuditorUserId] || null) : null,
                financeApprover: r.financeApproverUserId ? (userNames[r.financeApproverUserId] || null) : null,
                paidBy: r.paidByUserId ? (userNames[r.paidByUserId] || null) : null,
            };
        });

        const total = enriched.length;
        const items = enriched.slice((page - 1) * pageSize, page * pageSize);
        const totals = {
            count: total,
            totalKm: enriched.reduce((s, r) => s + (r.kmDriven || 0), 0),
            totalAmount: enriched.reduce((s, r) => s + (r.totalAmount || 0), 0),
            totalPaid: enriched.filter((r) => r.paidAt).reduce((s, r) => s + (r.totalAmount || 0), 0),
            totalUnpaid: enriched.filter((r) => !r.paidAt).reduce((s, r) => s + (r.totalAmount || 0), 0),
        };

        res.json({ success: true, items, total, page, pageSize, totals });
    } catch (err) {
        console.error("❌ HR TRANSPORT REPORT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch transport report" });
    }
});

// ============================================================
// PUT /leave-attendance/mark-exported -- marks all currently-unexported
// leave/attendance rows matching the given filters as exported (sets
// exportedAt = NOW()). Same filter semantics as the GET endpoint above
// (minus `exported` itself, since this only ever targets unexported
// rows) -- called after a CSV/PDF export completes so a fresh export
// naturally only grabs new records next time.
// ============================================================
router.put("/leave-attendance/mark-exported", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE), async (req, res) => {
    try {
        const { status, type, dateFrom, dateTo, search, empGroup } = req.body;

        let empNoFilter = await resolveSearchToEmpNos(search);
        const scopeFilter = await hrReportScopeFilter(req.user.role);
        const groupFilter = await empGroupFilter(empGroup);
        for (const filter of [scopeFilter, groupFilter]) {
            if (!filter) continue;
            empNoFilter = empNoFilter
                ? empNoFilter.filter((n) => filter.has(Number(n)))
                : [...filter];
        }
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const where = { exportedAt: null };
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };

        // dateFrom/dateTo filter on effectiveDate (fromDate for a leave
        // request, createdAt for a departure or attendance correction --
        // same computed field the GET endpoint uses), not a plain column,
        // so it can't fold into the SQL where above -- fetch ids first,
        // filter in JS, then bulk-update by id.
        const [leave, attendance] = await Promise.all([
            (!type || type === "leave")
                ? HrLeaveRequest.findAll({ where, attributes: ["id", "kind", "fromDate", "createdAt"] })
                : [],
            (!type || type === "attendance")
                ? HrAttendanceCorrectionRequest.findAll({ where, attributes: ["id", "createdAt"] })
                : [],
        ]);

        const inRange = (d) => (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
        const leaveIds = leave
            .filter((r) => inRange(r.fromDate || r.createdAt.toISOString().slice(0, 10)))
            .map((r) => r.id);
        const attendanceIds = attendance
            .filter((r) => inRange(r.createdAt.toISOString().slice(0, 10)))
            .map((r) => r.id);

        await Promise.all([
            leaveIds.length
                ? HrLeaveRequest.update({ exportedAt: new Date() }, { where: { id: { [Op.in]: leaveIds } } })
                : null,
            attendanceIds.length
                ? HrAttendanceCorrectionRequest.update({ exportedAt: new Date() }, { where: { id: { [Op.in]: attendanceIds } } })
                : null,
        ]);

        res.json({ success: true, count: leaveIds.length + attendanceIds.length });
    } catch (err) {
        console.error("❌ HR LEAVE/ATTENDANCE MARK-EXPORTED ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to mark records as exported" });
    }
});

// ============================================================
// PUT /transport/mark-exported -- marks all currently-unexported
// transport rows matching the given filters as exported.
// ============================================================
router.put("/transport/mark-exported", authenticateToken, requirePermission(PERMISSIONS.HR_REPORTS_TRANSPORT), async (req, res) => {
    try {
        const { status, dateFrom, dateTo, search, paidStatus, empGroup } = req.body;

        // Same company-wide scope as GET /transport above -- keep mark-
        // exported in sync with what the tab actually displays, otherwise
        // a scoped mark-exported call would silently miss rows the now-
        // unscoped view shows.
        let empNoFilter = await resolveSearchToEmpNos(search);
        const groupFilter = await empGroupFilter(empGroup);
        for (const filter of [groupFilter]) {
            if (!filter) continue;
            empNoFilter = empNoFilter
                ? empNoFilter.filter((n) => filter.has(Number(n)))
                : [...filter];
        }
        if (empNoFilter && empNoFilter.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const where = { exportedAt: null };
        if (status) where.status = status;
        if (empNoFilter) where.requesterEmpNo = { [Op.in]: empNoFilter };
        if (dateFrom || dateTo) {
            where.departureDate = {};
            if (dateFrom) where.departureDate[Op.gte] = dateFrom;
            if (dateTo) where.departureDate[Op.lte] = dateTo;
        }
        if (paidStatus === "paid") where.paidAt = { [Op.ne]: null };
        else if (paidStatus === "unpaid") where.paidAt = null;

        const [count] = await HrTransportRequest.update({ exportedAt: new Date() }, { where });
        res.json({ success: true, count });
    } catch (err) {
        console.error("❌ HR TRANSPORT MARK-EXPORTED ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to mark records as exported" });
    }
});

export default router;
