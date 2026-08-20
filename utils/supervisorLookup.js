// backend/utils/supervisorLookup.js
// Shared PayEmp.Supervisor_No lookups -- extracted from routes/hrRequests.js
// once routes/users.js needed the same "who does this person supervise"
// logic for manager-scoped user management. Always checked live against
// ERP, never cached/snapshotted, so a supervisor change takes effect
// immediately everywhere this is used.
import { withSqlRetry } from "../config/db.js";
import { User } from "../models/User.js";

export async function isSupervisorOf(supervisorEmpNo, employeeEmpNo) {
    if (!supervisorEmpNo || !employeeEmpNo) return false;
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("employeeEmpNo", employeeEmpNo)
        .input("supervisorEmpNo", supervisorEmpNo)
        .query(`
            SELECT 1 FROM [DB].[dbo].[PayEmp]
            WHERE Emp_num = @employeeEmpNo AND Supervisor_No = @supervisorEmpNo
        `));
    return result.recordset.length > 0;
}

// True if this employee has a resolvable real supervisor -- Supervisor_No
// is set, points to another active PayEmp row, AND that supervisor has an
// active InsUser login account. All three matter: a dangling/inactive ERP
// reference is treated as no supervisor (nobody could act as that manager
// either way), and so is a supervisor who's still active in payroll but
// whose app account was deleted/deactivated -- confirmed live: 100522's
// ERP Supervisor_No (400001) stayed pointed at a real, active employee
// after 400001's InsUser account was deleted, which would otherwise have
// silently stranded 100522's requests forever (nobody left who could both
// pass the ERP check AND actually log in to approve). Used to gate
// hr_manager's fallback-approver capability on the 3 manager-decision
// endpoints in routes/hrRequests.js -- that fallback must only kick in for
// genuinely unmanaged employees, never short-circuit a normal employee's
// real manager.
export async function hasRealSupervisor(employeeEmpNo) {
    if (!employeeEmpNo) return false;
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("employeeEmpNo", employeeEmpNo)
        .query(`
            SELECT e.Supervisor_No
            FROM [DB].[dbo].[PayEmp] e
            JOIN [DB].[dbo].[PayEmp] s ON s.Emp_num = e.Supervisor_No
            WHERE e.Emp_num = @employeeEmpNo
              AND e.Supervisor_No IS NOT NULL AND e.Supervisor_No <> 0
              AND s.Work_status = '1'
        `));
    if (!result.recordset.length) return false;
    const supervisorEmpNo = result.recordset[0].Supervisor_No;
    const account = await User.findOne({ where: { username: String(supervisorEmpNo), active: true } });
    return !!account;
}

// Company-wide list of active employees with no resolvable real supervisor
// (see hasRealSupervisor) -- backs hr_manager's view of GET
// /manager-approvals in routes/hrRequests.js, so the fallback-approver
// capability there is actually discoverable instead of requiring a known
// request id.
export async function getEmpNosWithoutRealSupervisor() {
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .query(`
            SELECT e.Emp_num, e.Supervisor_No
            FROM [DB].[dbo].[PayEmp] e
            LEFT JOIN [DB].[dbo].[PayEmp] s ON s.Emp_num = e.Supervisor_No AND s.Work_status = '1'
            WHERE e.Work_status = '1'
              AND (e.Supervisor_No IS NULL OR e.Supervisor_No = 0 OR s.Emp_num IS NULL)
        `));
    const noErpSupervisor = result.recordset.map((r) => r.Emp_num);

    // Employees whose ERP supervisor is real/active but whose app login
    // was deleted/deactivated -- same "can't actually act as manager"
    // gap hasRealSupervisor() checks for a single employee, done in bulk
    // here so this list stays complete.
    const withErpSupervisor = await withSqlRetry("erp", (pool) => pool.request()
        .query(`
            SELECT e.Emp_num, e.Supervisor_No
            FROM [DB].[dbo].[PayEmp] e
            JOIN [DB].[dbo].[PayEmp] s ON s.Emp_num = e.Supervisor_No
            WHERE e.Work_status = '1' AND s.Work_status = '1'
              AND e.Supervisor_No IS NOT NULL AND e.Supervisor_No <> 0
        `));
    const supervisorUsernames = [...new Set(withErpSupervisor.recordset.map((r) => String(r.Supervisor_No)))];
    const activeAccounts = supervisorUsernames.length
        ? await User.findAll({ where: { username: supervisorUsernames, active: true }, attributes: ['username'] })
        : [];
    const supervisorsWithLogin = new Set(activeAccounts.map((u) => u.username));
    const supervisorHasNoLogin = withErpSupervisor.recordset
        .filter((r) => !supervisorsWithLogin.has(String(r.Supervisor_No)))
        .map((r) => r.Emp_num);

    return [...new Set([...noErpSupervisor, ...supervisorHasNoLogin])];
}

// Resolves the InsUser account of an employee's real supervisor, for
// notifying them a new request needs their approval -- same "does this
// supervisor actually have a login" requirement as hasRealSupervisor,
// just returning the userId instead of a boolean. Null if the employee
// has no ERP supervisor or that supervisor has no active account (the
// hr_manager fallback case -- callers should notify hr_manager instead).
export async function getSupervisorUserId(employeeEmpNo) {
    if (!employeeEmpNo) return null;
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("employeeEmpNo", employeeEmpNo)
        .query(`
            SELECT e.Supervisor_No
            FROM [DB].[dbo].[PayEmp] e
            JOIN [DB].[dbo].[PayEmp] s ON s.Emp_num = e.Supervisor_No
            WHERE e.Emp_num = @employeeEmpNo
              AND e.Supervisor_No IS NOT NULL AND e.Supervisor_No <> 0
              AND s.Work_status = '1'
        `));
    if (!result.recordset.length) return null;
    const supervisorEmpNo = result.recordset[0].Supervisor_No;
    const account = await User.findOne({ where: { username: String(supervisorEmpNo), active: true } });
    return account?.userId || null;
}

// Same fallback population as isAuthorizedManagerDecision's hr_manager
// branch, for notifying someone when a new request has no resolvable real
// supervisor to notify instead.
export async function getFallbackManagerUserIds() {
    const accounts = await User.findAll({ where: { role: "hr_manager", active: true }, attributes: ["userId"] });
    return accounts.map((u) => u.userId);
}

export async function getSupervisedEmpNos(supervisorEmpNo) {
    if (!supervisorEmpNo) return [];
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("supervisorEmpNo", supervisorEmpNo)
        .query(`SELECT Emp_num FROM [DB].[dbo].[PayEmp] WHERE Supervisor_No = @supervisorEmpNo`));
    return result.recordset.map(r => r.Emp_num);
}

// Extra departments (PayEmp.Work_place) a role gets scope over regardless of
// the actual PayEmp.Supervisor_No chain. For installation_manager this is
// the full real org tree under Pay_CompTree parent 7000 ("عمليات التركيب" /
// Installation Operations) -- confirmed live via ParentIndx, not guessed:
// 7200 (قسم التركيب, core dept), 7310 (فريق نقل و تركيب السلات),
// 7320 (فريق تركيب أبواب و ماتورات الكراجات), 7400 (الحركة),
// 7500 (قسم تركيب المشاريع الخاصة). Deliberately NOT supervisor-chain-based:
// some installation_manager accounts (e.g. 202030) supervise zero employees
// in ERP, so relying on Supervisor_No alone left them unable to see/manage
// even the core 7200 department despite holding the role.
export const ROLE_EXTRA_WORK_PLACES = {
    installation_manager: ['7200', '7310', '7320', '7400', '7500'],
};

export async function getWorkPlaceEmpNos(workPlaces) {
    if (!workPlaces || !workPlaces.length) return [];
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .query(`SELECT Emp_num FROM [DB].[dbo].[PayEmp] WHERE Work_status = '1' AND Work_place IN (${workPlaces.map(w => `'${w}'`).join(',')})`));
    return result.recordset.map(r => r.Emp_num);
}
