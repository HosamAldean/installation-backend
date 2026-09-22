// backend/routes/payslip.js
// Employee self-service Payslip report -- same template/data as the
// existing Alpha (ERP) payroll system's own "قسيمة راتب" report, verified
// live against a real sample before writing this. Data sources (SQL
// Server, 'erp' pool):
//   - dbo.Pay_MonthCalc   -- the CURRENT month's payroll lines (one row
//     per pay component per employee) -- per explicit direction, only the
//     latest month is shown for now, not the full Pay_HistSalary archive
//     (that table has the same schema and could back a month picker
//     later, but is deliberately out of scope here).
//   - dbo.Pay_AlddInfo    -- PayCode -> Arabic/English label + Trs_type
//     (1 = allowance, 2 = deduction)
//   - dbo.PayEmp          -- employee header (name, basic salary,
//     national ID, hire date, workplace/job title string)
//   - dbo.COMPANY         -- comp_num -> company name (comp_name/comp_ename)
// 'CASH'/'BANK'/'Days' PayCodes are summary/informational rows in the
// source report (net cash paid, amount transferred to bank, working-day
// count), not itemized allowance/deduction lines -- excluded from the
// allowances/deductions arrays and surfaced as their own totals fields
// instead, matching the reference report's layout exactly.
import express from "express";
import { withSqlRetry } from "../config/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getPermissionsForRole } from "../middleware/permissions.js";
import { PERMISSIONS } from "../constants/permissions.js";
import { PayslipVisibility } from "../models/PayslipVisibility.js";

const router = express.Router();

function requireEmpNo(req, res) {
    if (!req.user.assignedEmpNo) {
        res.status(400).json({ success: false, message: "Your account isn't linked to a payroll record." });
        return null;
    }
    return parseInt(req.user.assignedEmpNo);
}

async function getVisibilityRow() {
    let row = await PayslipVisibility.findOne({ order: [["id", "ASC"]] });
    if (!row) row = await PayslipVisibility.create({ enabled: false });
    return row;
}

// ============================================================
// GET /visibility -- any authenticated user, so the frontend nav link/
// page can decide whether to show the feature at all.
// ============================================================
router.get("/visibility", authenticateToken, async (req, res) => {
    try {
        const row = await getVisibilityRow();
        res.json({ success: true, enabled: row.enabled });
    } catch (err) {
        console.error("❌ PAYSLIP VISIBILITY GET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch payslip visibility" });
    }
});

// ============================================================
// PUT /visibility -- gated by the HR_PAYSLIP_VISIBILITY_MANAGE grant
// (admin-editable via the Petra ERP Permissions page) rather than a
// hardcoded role list -- admin implicitly holds every key (see
// getPermissionsForRole), so no separate bypass is needed here. Single
// global switch (see model's own comment for why this isn't per-employee).
// ============================================================
router.put("/visibility", authenticateToken, async (req, res) => {
    const granted = await getPermissionsForRole(req.user.role);
    if (!granted.includes(PERMISSIONS.HR_PAYSLIP_VISIBILITY_MANAGE)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
    }
    try {
        const row = await getVisibilityRow();
        row.enabled = !!req.body.enabled;
        row.updatedByUserId = req.user.userId;
        await row.save();
        res.json({ success: true, enabled: row.enabled });
    } catch (err) {
        console.error("❌ PAYSLIP VISIBILITY PUT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update payslip visibility" });
    }
});

// ============================================================
// GET / -- the caller's own payslip for the current (latest) month only,
// straight from Pay_MonthCalc -- no year/month params, no archive lookup.
// ============================================================
router.get("/", authenticateToken, async (req, res) => {
    const empNo = requireEmpNo(req, res);
    if (empNo === null) return;

    try {
        const visibility = await getVisibilityRow();
        if (!visibility.enabled) {
            return res.status(403).json({ success: false, message: "Payslip viewing is currently disabled by HR" });
        }

        const empResult = await withSqlRetry("erp", (pool) => pool.request()
            .input("empNo", empNo)
            .query(`
                SELECT Comp_num, Emp_num, EmpName, EmpEngName, Basic_Salary, Social_num, National_No, Apt_Date, WPlaceDesc
                FROM dbo.PayEmp WHERE Emp_num = @empNo
            `));
        const emp = empResult.recordset[0];
        if (!emp) {
            return res.status(404).json({ success: false, message: "Payroll record not found" });
        }

        const compResult = await withSqlRetry("erp", (pool) => pool.request()
            .input("compNo", emp.Comp_num)
            .query(`SELECT comp_name, comp_ename FROM dbo.COMPANY WHERE comp_num = @compNo`));
        const company = compResult.recordset[0] || {};

        const rowsResult = await withSqlRetry("erp", (pool) => pool.request()
            .input("compNo", emp.Comp_num)
            .input("empNo", empNo)
            .query(`
                SELECT mc.PayCode, mc.PayAmt, mc.MonthNo, mc.PayDate, ai.Aldd_Desc, ai.Aldd_DescEng, ai.Trs_type
                FROM dbo.Pay_MonthCalc mc
                LEFT JOIN dbo.Pay_AlddInfo ai ON ai.CompNo = mc.CompNo AND ai.Aldd_code = mc.PayCode
                WHERE mc.CompNo = @compNo AND mc.EmpNo = @empNo
            `));
        const rows = rowsResult.recordset;

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "No payslip found for the current month" });
        }

        const SUMMARY_CODES = new Set(["CASH", "BANK", "DAYS"]);
        const allowances = [];
        const deductions = [];
        let netCash = 0;
        let bankTransfer = 0;
        for (const row of rows) {
            const codeUpper = row.PayCode.trim().toUpperCase();
            const amount = Number(row.PayAmt) || 0;
            if (codeUpper === "CASH") { netCash = amount; continue; }
            if (codeUpper === "BANK") { bankTransfer = amount; continue; }
            if (SUMMARY_CODES.has(codeUpper)) continue;
            const item = {
                code: row.PayCode,
                label: row.Aldd_Desc?.trim() || row.PayCode,
                labelEn: row.Aldd_DescEng?.trim() || row.PayCode,
                amount,
            };
            if (row.Trs_type === 1) allowances.push(item);
            else deductions.push(item);
        }
        const grossSalary = Math.round(allowances.reduce((s, a) => s + a.amount, 0) * 1000) / 1000;
        const totalDeductions = Math.round(deductions.reduce((s, d) => s + d.amount, 0) * 1000) / 1000;

        // WPlaceDesc is a legacy denormalized org-hierarchy string, levels
        // separated by runs of 2+ spaces (see utils/employeeLookup.js's
        // secondOrgLevel for the same parsing rule) -- the source report
        // joins every level with " / ", not just the second one.
        const jobTitle = (emp.WPlaceDesc || "")
            .split(/\s{2,}/)
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" / ");

        res.json({
            success: true,
            year: new Date(rows[0].PayDate).getFullYear(),
            month: rows[0].MonthNo,
            employee: {
                empNo: emp.Emp_num,
                name: emp.EmpName?.trim(),
                nameEn: emp.EmpEngName?.trim(),
                jobTitle,
                basicSalary: Number(emp.Basic_Salary) || 0,
                nationalNo: emp.National_No?.trim() || null,
                socialNo: emp.Social_num?.trim() || null,
                hireDate: emp.Apt_Date,
            },
            company: {
                name: company.comp_name?.trim() || null,
                nameEn: company.comp_ename?.trim() || null,
            },
            allowances,
            deductions,
            totals: { grossSalary, totalDeductions, netCash, bankTransfer },
        });
    } catch (err) {
        console.error("❌ PAYSLIP GET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch payslip" });
    }
});

export default router;
