import express from 'express';
import { getSqlPool } from '../config/db.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
// Previously unauthenticated — leaked every active employee's hourly salary
// (Basic_Salary / 240) to any caller with network access. Gate to
// manager/admin like the rest of the employee/team-management surface.
router.use(authenticateToken);
router.use(authorizeRoles('manager', 'admin'));

/**
 * ✅ GET /api/employees
 * Returns all active employees (Work_status = '1' & Work_place = '7200')
 */
router.get('/', async (req, res) => {
    try {
        const pool = await getSqlPool('erp');

        const result = await pool.request().query(`
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                e.Basic_Salary / 240 AS perHour,
                e.Job_code,
                j.job_Desc,
                e.WPlaceDesc,
                e.Work_status,
                e.Work_place
            FROM [DB].[dbo].[PayEmp] AS e
            LEFT JOIN [DB].[dbo].[Pay_Job] AS j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Work_status = '1'
              AND e.Work_place = '7200'
            ORDER BY e.EmpName
        `);

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            data: result.recordset,
        });

    } catch (err) {
        console.error('❌ Error fetching employees list:', err);
        res.status(500).json({
            success: false,
            message: 'Server error fetching employees list',
        });
    }
});

/**
 * ✅ GET /api/employees/available
 * Returns employees not assigned to any team
 */
router.get('/available', async (req, res) => {
    try {
        const pool = await getSqlPool('erp');

        const result = await pool.request().query(`
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                e.Basic_Salary / 240 AS perHour,
                e.Job_code,
                j.job_Desc,
                e.WPlaceDesc,
                e.Work_status,
                e.Work_place
            FROM [DB].[dbo].[PayEmp] AS e
            LEFT JOIN [DB].[dbo].[Pay_Job] AS j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Work_status = '1'
              AND e.Work_place = '7200'
              AND e.Emp_num NOT IN (
                  SELECT emp_no FROM stockhouse.team_members
              )
            ORDER BY e.EmpName
        `);

        res.set('Cache-Control', 'no-store');
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('❌ Error fetching available employees:', err);
        res.status(500).json({
            success: false,
            message: 'Server error fetching available employees',
        });
    }
});

export default router;
