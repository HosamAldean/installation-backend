import express from 'express';
import { User } from '../models/User.js';
import { getSqlPool } from '../config/db.js';
import { Op } from 'sequelize'
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

/* ----------------------------------
   Auth middleware
   Previously a local implementation that only checked the Authorization
   header — broke once the frontend moved to cookie-based auth (see
   ~/utils/api.ts) since this route never received a header to check.
   Now uses the same shared, cookie-aware middleware as the rest of the app.
---------------------------------- */
const requireAuth = authenticateToken;
const requireAdmin = authorizeRoles('admin');

/* ----------------------------------
   GET current user
---------------------------------- */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.userId, {
            attributes: [
                'userId',
                'username',
                'firstName',
                'lastName',
                'email',
                'role',
                'avatarUrl',
                'teamId',
                'active'
            ]
        });
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found' });

        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to fetch user' });
    }
});

/* ----------------------------------
   LIST users (Admin / Manager)
---------------------------------- */
router.get('/', requireAuth, async (req, res) => {
    try {
        if (!['admin', 'manager'].includes(req.user.role))
            return res.status(403).json({ success: false, message: 'Forbidden' });

        // Was silently ignored — a duplicate, dead GET '/' handler further
        // down this file supported ?search=, but Express only ever dispatches
        // to the first matching route, so admin/Users.tsx's search box never
        // actually filtered anything server-side.
        const search = String(req.query.search || '').trim();
        const where = search
            ? {
                [Op.or]: [
                    { username: { [Op.like]: `%${search}%` } },
                    { firstName: { [Op.like]: `%${search}%` } },
                    { lastName: { [Op.like]: `%${search}%` } },
                    { email: { [Op.like]: `%${search}%` } },
                ],
            }
            : undefined;

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
        const offset = (page - 1) * pageSize;

        const { count, rows: users } = await User.findAndCountAll({
            where,
            attributes: [
                'userId',
                'username',
                'firstName',
                'lastName',
                'email',
                'role',
                'teamId',
                'active',
                'createdAt'
            ],
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
        });

        res.json({ success: true, users, total: count, page, pageSize });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

/* ----------------------------------
   CREATE user (Admin)
---------------------------------- */
// CREATE user (Admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { empNo, role = 'user', teamId: bodyTeamId, password: bodyPassword } = req.body;

        let username, firstName, lastName, email, password, teamId;

        if (empNo) {
            const pool = await getSqlPool('erp');
            const sqlDB = process.env.MSSQL1_DB;

            const empRes = await pool.request()
                .input('empNo', empNo)
                .query(`
                    SELECT
                        Emp_num AS empNo,
                        EmpName AS name_ar,
                        EmpEngName AS name_en
                    FROM ${sqlDB}.dbo.PayEmp
                    WHERE Emp_num = @empNo
                `);

            const emp = empRes.recordset[0];
            if (!emp)
                return res.status(404).json({ success: false, message: 'Employee not found' });

            username = String(emp.empNo);   // ✅ HERE
            firstName = emp.name_ar || emp.name_en || '';
            lastName = '';
            email = `${username}@company.com`;
            // Previously always hardcoded to 'Default123!' and teamId to the
            // employee number — the frontend's create-user form requires and
            // sends a real custom password plus a real teamId, both of which
            // were silently discarded, so every admin-created account ended
            // up with a predictable default password regardless of what was
            // entered.
            password = await bcrypt.hash(bodyPassword || 'Default123!', 10);
            teamId = bodyTeamId || String(emp.empNo);
        } else {
            const { username: u, password: p, firstName: fn, lastName: ln, email: em } = req.body;

            const exists = await User.findOne({ where: { username: u } });
            if (exists)
                return res.status(400).json({ success: false, message: 'Username already exists' });

            username = u;
            firstName = fn;
            lastName = ln;
            email = em;
            password = await bcrypt.hash(p, 10);
        }

        // 🔐 prevent duplicate empNo users
        const exists = await User.findOne({ where: { username } });
        if (exists)
            return res.status(400).json({
                success: false,
                message: 'User already exists for this employee',
            });

        const user = await User.create({
            username,
            password,
            firstName,
            lastName,
            email,
            role,
            teamId,
            assignedEmpNo: empNo ? String(empNo) : null,
            active: true,
        });

        res.status(201).json({ success: true, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to create user' });
    }
});


/* ----------------------------------
   UPDATE user (Admin / Self)
---------------------------------- */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        if (req.user.userId !== Number(id) && req.user.role !== 'admin')
            return res.status(403).json({ success: false, message: 'Forbidden' });

        const user = await User.findByPk(id);
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found' });

        const {
            firstName,
            lastName,
            email,
            avatarUrl,
            role,
            teamId,
            active
        } = req.body;

        if (firstName !== undefined) user.firstName = firstName;
        if (lastName !== undefined) user.lastName = lastName;
        if (email !== undefined) user.email = email;
        if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

        // admin-only fields
        if (req.user.role === 'admin') {
            if (role !== undefined) user.role = role;
            if (teamId !== undefined) user.teamId = teamId;
            if (active !== undefined) user.active = active;
        }

        await user.save();

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to update user' });
    }
});

/* ----------------------------------
   RESET password (Admin)
---------------------------------- */
router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }
        const user = await User.findByPk(req.params.id);
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found' });

        user.password = await bcrypt.hash(password, 10);
        await user.save();

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
});

/* ----------------------------------
   DELETE user (Admin)
---------------------------------- */
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found' });

        await user.destroy();
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
});


router.get('/employees', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { search = '' } = req.query;

        // 1️⃣ get existing usernames (empNo)
        const existingUsers = await User.findAll({
            attributes: ['username'],
        });

        const usedEmpNos = existingUsers
            .map(u => Number(u.username))
            .filter(n => !isNaN(n));

        const pool = await getSqlPool('erp');
        const sqlDB = process.env.MSSQL1_DB;

        let query = `
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                j.job_Desc
            FROM ${sqlDB}.dbo.PayEmp e
            LEFT JOIN ${sqlDB}.dbo.Pay_Job j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Work_status = '1'
              AND e.Work_place = '7200'
              AND e.job_code NOT IN ('191')
        `;

        if (usedEmpNos.length) {
            query += ` AND e.Emp_num NOT IN (${usedEmpNos.join(',')})`;
        }

        if (search) {
            query += `
                AND (
                    e.EmpName LIKE @search
                    OR e.EmpEngName LIKE @search
                    OR j.job_Desc LIKE @search
                )
            `;
        }

        query += ` ORDER BY e.EmpName`;

        const request = pool.request();
        if (search) request.input('search', `%${search}%`);

        const result = await request.query(query);

        res.json({ success: true, employees: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to fetch employees' });
    }
});



export default router;
