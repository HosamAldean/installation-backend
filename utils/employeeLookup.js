// backend/utils/employeeLookup.js
// Batch-resolve PayEmp/Pay_Job names for a set of empNos -- the HR
// request tables (sequelizeUtf8, MySQL) only ever store requesterEmpNo,
// never a name, since employees live in the ERP (SQL Server) entirely.
// Used by the new HR/Accounting reports, which need a readable name
// instead of a bare employee number.
import { withSqlRetry } from "../config/db.js";

// PayEmp.WPlaceDesc is a legacy denormalized org-hierarchy string, levels
// separated by runs of 2+ spaces (not truly fixed-width -- run lengths vary
// row to row, confirmed live e.g. "...العام    عمليات..." vs "...العام
// المبيعات..."), most specific level last, e.g.
// "المدير العام    عمليات الحديد   إنتاج الحديد" (General Manager -> Iron
// Operations -> Iron Production). GlDeptNo/GLDEPMF looked like the
// "proper" department link but is unused live (0 of 536 active employees
// have it set) -- this is the field that's actually populated. Department
// here means the *second* level specifically (e.g. "عمليات الحديد" /
// "Iron Operations"), not the top-level company/GM node or the most
// specific team -- some employees only have one level, in which case
// there's no second segment and this returns null rather than guessing.
function secondOrgLevel(wPlaceDesc) {
    if (!wPlaceDesc) return null;
    const levels = wPlaceDesc.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    return levels[1] ?? null;
}

export async function resolveEmployeeNames(empNos) {
    const uniqueEmpNos = [...new Set(empNos)].filter((n) => Number.isInteger(n));
    if (uniqueEmpNos.length === 0) return {};

    const result = await withSqlRetry("erp", (pool) => pool.request().query(`
        SELECT e.Emp_num AS empNo, e.EmpName AS name_ar, e.EmpEngName AS name_en, j.job_Desc, e.WPlaceDesc
        FROM [DB].[dbo].[PayEmp] e
        LEFT JOIN [DB].[dbo].[Pay_Job] j ON e.Job_code = j.job_code AND j.Comp_num = '1'
        WHERE e.Emp_num IN (${uniqueEmpNos.join(",")})
    `));

    const byEmpNo = {};
    for (const row of result.recordset) {
        byEmpNo[row.empNo] = {
            empNo: row.empNo,
            name_ar: row.name_ar,
            name_en: row.name_en,
            job_Desc: row.job_Desc,
            department: secondOrgLevel(row.WPlaceDesc),
        };
    }
    return byEmpNo;
}

// Batched sibling of routes/hrRequests.js's GET /vacation-balance --
// exact same as-of-today formula (see that route's extensive comments on
// why: Pay_VacBal.DueBal alone is the full-year figure, not prorated;
// HRP_GetVacBalance can't be called directly because of an EmpNo-overflow
// bug in a vendor SP it calls), just batched via EmpNo IN (...) instead of
// a single @empNo so the HR queue (routes/hrRequests.js's GET /hr-queue)
// can show each pending leave/departure requester's balance in one query
// instead of one per row. Deliberately NOT used to replace that route's
// own single-employee query -- this is a separate, additive function so
// the already-verified self-service formula stays untouched.
export async function resolveVacationBalances(empNos) {
    const uniqueEmpNos = [...new Set(empNos)].filter((n) => Number.isInteger(n));
    if (uniqueEmpNos.length === 0) return {};
    const balYear = new Date().getFullYear();

    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("balYear", balYear)
        .query(`
            DECLARE @ToDate smalldatetime = GETDATE();
            SELECT
                vb.EmpNo AS empNo,
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
            WHERE vb.EmpNo IN (${uniqueEmpNos.join(",")}) AND vb.VacType = 1 AND vb.BalYear = @balYear
        `));

    const byEmpNo = {};
    for (const row of result.recordset) {
        byEmpNo[row.empNo] = row.remainingBalance != null ? Math.round(row.remainingBalance * 100) / 100 : null;
    }
    return byEmpNo;
}
