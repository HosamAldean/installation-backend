// backend/utils/supervisorLookup.js
// Shared PayEmp.Supervisor_No lookups -- extracted from routes/hrRequests.js
// once routes/users.js needed the same "who does this person supervise"
// logic for manager-scoped user management. Always checked live against
// ERP, never cached/snapshotted, so a supervisor change takes effect
// immediately everywhere this is used.
import { withSqlRetry } from "../config/db.js";

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

export async function getSupervisedEmpNos(supervisorEmpNo) {
    if (!supervisorEmpNo) return [];
    const result = await withSqlRetry("erp", (pool) => pool.request()
        .input("supervisorEmpNo", supervisorEmpNo)
        .query(`SELECT Emp_num FROM [DB].[dbo].[PayEmp] WHERE Supervisor_No = @supervisorEmpNo`));
    return result.recordset.map(r => r.Emp_num);
}
