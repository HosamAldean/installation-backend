// backend/utils/employeeLookup.js
// Batch-resolve PayEmp/Pay_Job names for a set of empNos -- the HR
// request tables (sequelizeUtf8, MySQL) only ever store requesterEmpNo,
// never a name, since employees live in the ERP (SQL Server) entirely.
// Used by the new HR/Accounting reports, which need a readable name
// instead of a bare employee number.
import { withSqlRetry } from "../config/db.js";

export async function resolveEmployeeNames(empNos) {
    const uniqueEmpNos = [...new Set(empNos)].filter((n) => Number.isInteger(n));
    if (uniqueEmpNos.length === 0) return {};

    const result = await withSqlRetry("erp", (pool) => pool.request().query(`
        SELECT e.Emp_num AS empNo, e.EmpName AS name_ar, e.EmpEngName AS name_en, j.job_Desc
        FROM [DB].[dbo].[PayEmp] e
        LEFT JOIN [DB].[dbo].[Pay_Job] j ON e.Job_code = j.job_code AND j.Comp_num = '1'
        WHERE e.Emp_num IN (${uniqueEmpNos.join(",")})
    `));

    const byEmpNo = {};
    for (const row of result.recordset) byEmpNo[row.empNo] = row;
    return byEmpNo;
}
