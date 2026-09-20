// backend/utils/ittihadEmployeeLookup.js
// Batch-resolve PayEmp names for Ittihad (CompNo=10) employees only.
// Deliberately separate from utils/employeeLookup.js: that helper filters
// PayEmp by Emp_num alone (no Comp_num), which is only safe because every
// existing caller implicitly means company 1 -- reusing it here would risk
// matching another company's employee if an Emp_num were ever shared
// across companies (verified no collisions today, but not a guarantee to
// build on). Also skips employeeLookup.js's Pay_Job join, which is
// hardcoded to Comp_num='1' and would silently return no job title for
// every Ittihad employee.
import { withSqlRetry } from "../config/db.js";

export const ITTIHAD_COMP_NO = 10;

export async function resolveIttihadEmployeeNames(empNos) {
    const uniqueEmpNos = [...new Set(empNos)].filter((n) => Number.isInteger(n));
    if (uniqueEmpNos.length === 0) return {};

    const result = await withSqlRetry("erp", (pool) => pool.request().query(`
        SELECT e.Emp_num AS empNo, e.EmpName AS name_ar, e.EmpEngName AS name_en, j.job_Desc AS jobDesc
        FROM [DB].[dbo].[PayEmp] e
        LEFT JOIN [DB].[dbo].[Pay_Job] j ON e.Job_code = j.job_code AND j.Comp_num = ${ITTIHAD_COMP_NO}
        WHERE e.Comp_num = ${ITTIHAD_COMP_NO} AND e.Emp_num IN (${uniqueEmpNos.join(",")})
    `));

    const byEmpNo = {};
    for (const row of result.recordset) byEmpNo[row.empNo] = row;
    return byEmpNo;
}

// A free-text search resolves to matching Ittihad empNos up front (ERP
// names aren't in the MySQL staging table), or a single exact empNo if the
// search term is purely numeric -- same convention as
// routes/hrReports.js's resolveSearchToEmpNos, scoped to Comp_num=10.
// Returns null if no search term was given (no filtering), or an array
// (possibly empty) otherwise.
export async function resolveIttihadSearchToEmpNos(search) {
    if (!search) return null;
    const trimmed = String(search).trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return [parseInt(trimmed, 10)];

    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("search", `%${trimmed}%`)
        .query(`
            SELECT Emp_num FROM [DB].[dbo].[PayEmp]
            WHERE Comp_num = ${ITTIHAD_COMP_NO} AND (EmpName LIKE @search OR EmpEngName LIKE @search)
        `));
    return result.recordset.map((r) => r.Emp_num);
}

// Realand's own right-padded 12h format, e.g. "07:41" -> "  7:41AM",
// "16:30" -> "  4:30PM" -- matches TA_EmpTimeSheet's existing Emp_IN/
// Emp_Out/Prog_IN/Prog_Out values exactly (verified live). Shared by the
// clock-log parser (routes/ittihadAttendance.js) and the TA_DailyProgram
// lookup below, which stores its own Prog_IN/Prog_OUT as plain 24h "HH:MM".
export function to12hPadded(time24) {
    if (!time24) return null;
    const [h, m] = time24.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")}`.padStart(6) + ampm;
}

// Authoritative per-employee shift assignment. Note: this is
// [DB].[dbo].[Ta_EmpCardInfo] -- NOT the similarly-named EmpAttCards table
// (a mistake made once already: EmpAttCards has zero rows for CompNo=10 and
// looked like "no shift setup exists for Ittihad", but Ta_EmpCardInfo has
// real ShiftNo assignments for all 64 configured Ittihad employees, and is
// the exact table TA_RptDailyAttendance -- the ERP's own daily-attendance
// report -- INNER JOINs against). Returns {} for an employee with no
// card-info row; callers must leave shift fields null in that case rather
// than guessing.
export async function resolveIttihadShiftAssignments(empNos) {
    const uniqueEmpNos = [...new Set(empNos)].filter((n) => Number.isInteger(n));
    if (uniqueEmpNos.length === 0) return {};

    const result = await withSqlRetry("erp", (pool) => pool.request().query(`
        SELECT EmpNo AS empNo, ShiftNo AS shiftNo
        FROM [DB].[dbo].[Ta_EmpCardInfo]
        WHERE CompNo = ${ITTIHAD_COMP_NO} AND EmpNo IN (${uniqueEmpNos.join(",")})
    `));

    const byEmpNo = {};
    for (const row of result.recordset) byEmpNo[row.empNo] = row.shiftNo;
    return byEmpNo;
}

// Authoritative per-shift daily schedule -- [DB].[dbo].[TA_DailyProgram]
// (CompNo=10), the same table TA_RptDailyAttendance INNER JOINs on
// Daily_Prog=ProgID. Confirmed live: ProgID 1/2/3 (Administration/Factory/
// Installation) are all currently 08:00-16:30 (8.5h) for Ittihad -- this
// supersedes any previously assumed/manually-told schedule, since it's the
// ERP's own live source of truth. Small/static reference table (4 rows),
// safe to query fresh each time rather than caching.
export async function getIttihadDailyPrograms() {
    const result = await withSqlRetry("erp", (pool) => pool.request().query(`
        SELECT ProgID AS progId, Prog_IN AS progIn24, Prog_OUT AS progOut24, Shift_Hrs AS shiftHrs
        FROM [DB].[dbo].[TA_DailyProgram]
        WHERE CompNo = ${ITTIHAD_COMP_NO}
    `));

    const byProgId = {};
    for (const row of result.recordset) {
        byProgId[String(row.progId).trim()] = {
            progIn: to12hPadded(row.progIn24),
            progOut: to12hPadded(row.progOut24),
            shiftHrs: row.shiftHrs,
        };
    }
    return byProgId;
}
