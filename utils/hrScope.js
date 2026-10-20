// backend/utils/hrScope.js
// Employee scope for the 3 HR-tier roles (hr_factory, hr_ittihad, hr) --
// who each one can create/manage accounts for, approve hr-queue requests
// from, and see reports for. Company and department data lives in ERP
// PayEmp (Comp_num, Work_place), not InsUser, so this is always a live
// SQL Server lookup -- same pattern as utils/supervisorLookup.js.
import { withSqlRetry } from "../config/db.js";
import { User } from "../models/User.js";
import { PermissionGrant } from "../models/PermissionGrant.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { getCurrentGmEmpNos } from "./supervisorLookup.js";

const SQL_DB = process.env.MSSQL1_DB;

// "المجمع الصناعي" (Industrial Complex) is a Petra (Comp_num=1) department
// spanning Work_place 6000-6999 -- confirmed live against Pay_CompTree,
// NOT a separate company. Factory HR also covers "إنتاج الحديد" (Iron
// Production, Work_place 8001 -- the 3xxxxx employees), per explicit
// direction 2026-10-15; it used to fall to general hr. Ittihad
// (Comp_num=10) is a genuinely separate company with its own employee-
// numbering scheme.
const FACTORY_WHERE = "Comp_num = 1 AND (Work_place BETWEEN 6000 AND 6999 OR Work_place = 8001)";
const ITTIHAD_WHERE = "Comp_num = 10";
// Everyone not in either of the above two.
const GENERAL_WHERE = `NOT (${FACTORY_WHERE}) AND Comp_num <> 10`;

// role -> SQL WHERE fragment against PayEmp -- full scope for accounts,
// hr-queue requests, and reports alike. hr used to be split into two
// separate roles (hr / hr_general) by Emp_num prefix "100", but per
// explicit direction that was merged back into one 'hr' role covering the
// whole general pool -- the 100-prefix split still exists, just as an
// optional display/filter on the reports screen only (see
// getEmpNosByPrefixGroup below), not as an access-control boundary.
export const HR_ROLE_WHERE = {
    hr_factory: FACTORY_WHERE,
    hr_ittihad: ITTIHAD_WHERE,
    hr: GENERAL_WHERE,
};

export function isHrScopedRole(role) {
    return Object.prototype.hasOwnProperty.call(HR_ROLE_WHERE, role);
}

async function empNosForWhere(where) {
    if (!where) return [];
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .query(`SELECT Emp_num FROM ${SQL_DB}.dbo.PayEmp WHERE Work_status = '1' AND ${where}`));
    return result.recordset.map((r) => r.Emp_num);
}

// Account-management/hr-queue/report scope -- identical for all 3 uses
// now that the 100-prefix split is reports-only (see below), so a single
// map/lookup covers everything.
export async function getHrScopedEmpNos(role) {
    return empNosForWhere(HR_ROLE_WHERE[role]);
}

export async function isInHrScope(role, targetEmpNo) {
    const where = HR_ROLE_WHERE[role];
    if (!where || !targetEmpNo || isNaN(targetEmpNo)) return false;
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("empNo", targetEmpNo)
        .query(`SELECT 1 FROM ${SQL_DB}.dbo.PayEmp WHERE Emp_num = @empNo AND ${where}`));
    return result.recordset.length > 0;
}

// hr-queue uses the exact same scope as everything else now -- kept as
// separate exports (rather than reusing getHrScopedEmpNos/isInHrScope
// directly) so routes/hrRequests.js's call sites don't need to change if
// queue and report/account scope ever need to diverge again.
export const getHrQueueEmpNos = getHrScopedEmpNos;
export const isInHrQueueScope = isInHrScope;

// Reports-screen-only display filter: every active employee whose Emp_num
// starts with "100", or (group='other') every active employee who doesn't.
// NOT a security/scope boundary -- confirmed this prefix isn't a real
// department (scattered across ~30 unrelated departments company-wide),
// just an existing hire-batch numbering convention -- so this is exposed
// as an optional slice on top of a role's normal (already-scoped) report
// view, not a role of its own. See GET /leave-attendance and GET
// /transport in routes/hrReports.js.
// Which HR-tier InsUser accounts to notify when a request reaches
// pending_hr/pending_hr_audit for this requester -- the scoped role that
// actually covers them (factory/ittihad/general), plus hr_manager, which
// stays unscoped/company-wide everywhere else in this file too.
export async function getHrReviewerUserIds(requesterEmpNo) {
    let scopedRole = "hr";
    if (await isInHrScope("hr_factory", requesterEmpNo)) scopedRole = "hr_factory";
    else if (await isInHrScope("hr_ittihad", requesterEmpNo)) scopedRole = "hr_ittihad";
    const reviewers = await User.findAll({
        where: { role: [scopedRole, "hr_manager"], active: true },
        attributes: ["userId"],
    });
    return reviewers.map((u) => u.userId);
}

// Factory-manager approval stage (status pending_factory_mgr), between
// the direct manager and the next stage (HR, HR audit, or for overtime the
// GM), per explicit direction 2026-10-18. Covers factory-HR employees
// (FACTORY_WHERE) except the 300xxx numbers (Iron Production staff). The
// factory manager is a fixed employee number -- 100254, head of
// Work_place 6000 (Industrial Complex) -- not a job code, as requested.
export const FACTORY_MANAGER_EMP_NO = 100254;

// Second-approval stage for Ittihad installation (per explicit direction
// 2026-10-20): any manager approval made by someone in Work_place 1364
// ("مشرف أعمال التركيب", installation works supervisor -- today 978) also
// needs employee 554's approval. Keyed on who gave the FIRST approval,
// not the requester's own work place, so it covers everyone that
// supervisor approves for (incl. 975 in Work_place 1354). Shares the
// pending_factory_mgr status/columns with the factory-manager stage; which
// of the two approvers a pending request waits on is derived by
// secondStageApproverFor below.
export const SECOND_APPROVAL_SOURCE_WORK_PLACES = [1364];
export const INSTALLATION_SECOND_APPROVER_EMP_NO = 554;
const SECOND_APPROVER_EMP_NOS = [FACTORY_MANAGER_EMP_NO, INSTALLATION_SECOND_APPROVER_EMP_NO];

// Active employees whose approval triggers the 554 stage.
export async function getSecondApprovalSourceEmpNos() {
    return empNosForWhere(`Work_place IN (${SECOND_APPROVAL_SOURCE_WORK_PLACES.join(",")})`);
}

async function hasActiveAccount(empNo) {
    return (await User.count({ where: { assignedEmpNo: empNo, active: true } })) > 0;
}

// Which employee must give the second approval for a request that its
// manager (managerApproverEmpNo -- null when admin/hr_manager fallback
// decided) just approved, or null when no second stage applies. Skipped
// when that person already approved it as the direct manager, for their
// own requests, and when they have no active account (otherwise the
// request would wait on nobody).
export async function getSecondApproverEmpNo(requesterEmpNo, managerApproverEmpNo) {
    const requester = parseInt(requesterEmpNo);
    const managerApprover = parseInt(managerApproverEmpNo);
    if (!requester) return null;

    if (managerApprover && (await getSecondApprovalSourceEmpNos()).includes(managerApprover)) {
        const approver = INSTALLATION_SECOND_APPROVER_EMP_NO;
        if (requester === approver || managerApprover === approver) return null;
        return (await hasActiveAccount(approver)) ? approver : null;
    }

    if (requester === FACTORY_MANAGER_EMP_NO) return null;
    if (managerApprover === FACTORY_MANAGER_EMP_NO) return null;
    if (String(requester).startsWith("300")) return null;
    if (!(await isInHrScope("hr_factory", requester))) return null;
    return (await hasActiveAccount(FACTORY_MANAGER_EMP_NO)) ? FACTORY_MANAGER_EMP_NO : null;
}

// For a request already at pending_factory_mgr: who it's waiting on.
// Derived from who gave the first approval, so no extra column is needed
// (and requests already pending for the factory manager stay his).
export function secondStageApproverFor(request, sourceEmpNos) {
    return sourceEmpNos.includes(parseInt(request.managerApproverEmpNo))
        ? INSTALLATION_SECOND_APPROVER_EMP_NO
        : FACTORY_MANAGER_EMP_NO;
}

export function isSecondApproverEmpNo(empNo) {
    return SECOND_APPROVER_EMP_NOS.includes(parseInt(empNo));
}

// Active InsUser accounts for one second-stage approver.
export async function getUserIdsForEmpNo(empNo) {
    const users = await User.findAll({ where: { assignedEmpNo: empNo, active: true }, attributes: ["userId"] });
    return users.map((u) => u.userId);
}

// Which InsUser accounts to notify when a transport request reaches
// pending_finance -- whichever roles actually hold
// PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE right now (admin-editable via
// PermissionGrants, so this stays correct if grants change rather than
// hardcoding accounting/accounting_manager).
export async function getFinanceReviewerUserIds() {
    const grants = await PermissionGrant.findAll({
        where: { permissionKey: PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE },
        attributes: ["role"],
    });
    const roles = grants.map((g) => g.role);
    if (roles.length === 0) return [];
    const reviewers = await User.findAll({
        where: { role: roles, active: true },
        attributes: ["userId"],
    });
    return reviewers.map((u) => u.userId);
}

// Which InsUser accounts to notify when an overtime request reaches
// pending_gm. Resolved live via getCurrentGmEmpNos (Job_code=11,
// Comp_num=1), not role or a stored empNo -- see that function's comment.
export async function getGmReviewerUserIds() {
    const gmEmpNos = await getCurrentGmEmpNos();
    if (gmEmpNos.length === 0) return [];
    const reviewers = await User.findAll({
        where: { assignedEmpNo: gmEmpNos, active: true },
        attributes: ["userId"],
    });
    return reviewers.map((u) => u.userId);
}

// Daily visits report (HR form 10-35) is only for these ERP work places,
// per explicit direction 2026-10-19: 5310 "خدمات القياس و المساحة"
// (Measurement & Survey Services, Projects dept., Comp_num 1). Checked
// live against PayEmp like the HR scopes above, so moving someone in or
// out of the department in the ERP takes effect without a code change.
export const VISIT_REPORT_WORK_PLACES = [5310];

export async function isEligibleForVisitReport(empNo) {
    const n = parseInt(empNo);
    if (!n) return false;
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("empNo", n)
        .query(`SELECT 1 FROM ${SQL_DB}.dbo.PayEmp
                WHERE Emp_num = @empNo AND Work_status = 1
                  AND Work_place IN (${VISIT_REPORT_WORK_PLACES.map(Number).join(",")})`));
    return result.recordset.length > 0;
}

export async function getEmpNosByPrefixGroup(group) {
    const cond = group === '100'
        ? "CAST(Emp_num AS VARCHAR) LIKE '100%'"
        : "CAST(Emp_num AS VARCHAR) NOT LIKE '100%'";
    return empNosForWhere(cond);
}
