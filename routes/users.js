import express from 'express';
import { User } from '../models/User.js';
import { UserAccountAudit } from '../models/UserAccountAudit.js';
import { getSqlPool } from '../config/db.js';
import { Op } from 'sequelize'
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { isSupervisorOf, getSupervisedEmpNos, ROLE_EXTRA_WORK_PLACES, getWorkPlaceEmpNos } from '../utils/supervisorLookup.js';
import { isHrScopedRole, getHrScopedEmpNos, isInHrScope } from '../utils/hrScope.js';

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
// Gate on top of requireAuth for the account-management endpoints below
// (list/create/update) -- this file's own data-driven Supervisor_No/
// HR-tier scoping (see hasCompanyWideScope/getScopedEmpNos further down)
// still decides *whose* accounts a manager can touch; this decides
// whether they can reach these endpoints at all.
const requireManageUsers = requirePermission(PERMISSIONS.USERS_MANAGE);

// Privileged roles that only an actual admin account may grant, revoke, or
// touch at all -- CORRECTED: this whole file used to gate every write
// action to the 'admin' role or a hardcoded 'installation_manager' special
// case. Per explicit direction, "manager" access is now data-driven (same
// PayEmp.Supervisor_No relationship used for HR-request approval routing
// in routes/hrRequests.js) rather than role-based: any employee who
// supervises at least one other employee can create/manage accounts for
// their own reports, but granting hr/admin, or touching an existing
// hr/admin account at all, stays admin-only. hr_manager is treated
// identically to hr throughout this file (same company-wide scope, same
// privilege) -- it's a senior HR role, not a differently-scoped one.
// hr_factory/hr_ittihad are the 2 other HR-tier roles split out of the old
// blanket 'hr' (see utils/hrScope.js) -- same admin-only grant/touch
// restriction applies to both.
const PRIVILEGED_ROLES = ['admin', 'hr', 'hr_manager', 'hr_factory', 'hr_ittihad'];

// Further restricts which roles specific manager roles may assign, on top
// of the PRIVILEGED_ROLES block above -- e.g. installation_manager can
// manage accounts for anyone in its scope (see getScopedEmpNos), but may
// only ever set their role to one of these, not e.g. 'sales' or
// 'shipping_manager' just because it happens to supervise someone with that
// role today. installation_supervisor (view-only, see
// blockWritesForReadOnlyRoles in middleware/permissions.js) is included --
// installation_manager can hand out read-only access itself without
// needing an admin. Roles with no entry here keep the old behavior
// (anything not in PRIVILEGED_ROLES).
const ROLE_ASSIGNABLE_ROLES = {
    installation_manager: ['employee', 'installation_manager', 'installation_employee', 'installation_supervisor'],
};

function isRoleAssignable(actorRole, targetRole) {
    const allowed = ROLE_ASSIGNABLE_ROLES[actorRole];
    return !allowed || allowed.includes(targetRole);
}

// Only admin and hr_manager get company-wide scope (any employee, not just
// their own reports) for listing/creating/managing user accounts -- hr_manager
// stays the "senior HR, sees everything" tier. Plain hr is no longer
// company-wide: it's one of the 3 scoped HR-tier roles (hr_factory,
// hr_ittihad, hr -- see utils/hrScope.js), each limited to its own slice
// of the company (hr's slice is the whole "everyone else" pool). Granting
// any HR-tier role to someone else is still admin-only regardless (see
// PRIVILEGED_ROLES above) -- this is about *whose* accounts you can touch,
// not *what* you can turn them into.
function hasCompanyWideScope(role) {
    return role === 'admin' || role === 'hr_manager';
}

// Union of "employees this manager supervises per PayEmp.Supervisor_No",
// "employees in this role's extra department scope" (see
// ROLE_EXTRA_WORK_PLACES in supervisorLookup.js -- e.g. installation_manager
// also covers Work_place 7500/7310 company-wide, regardless of who actually
// supervises those employees in ERP), and "employees in this HR-tier role's
// company/department/emp-number scope" (see utils/hrScope.js).
async function getScopedEmpNos(req) {
    const supervisorEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
    const supervised = await getSupervisedEmpNos(supervisorEmpNo);
    const extraWorkPlaces = ROLE_EXTRA_WORK_PLACES[req.user.role];
    const extra = extraWorkPlaces ? await getWorkPlaceEmpNos(extraWorkPlaces) : [];
    const hrScoped = isHrScopedRole(req.user.role) ? await getHrScopedEmpNos(req.user.role) : [];
    return [...new Set([...supervised, ...extra, ...hrScoped])];
}

// Single-target version of getScopedEmpNos, for create/update handlers that
// only need to check one employee rather than list the whole scope.
async function isInManagerScope(req, targetEmpNo) {
    if (isNaN(targetEmpNo)) return false;
    const supervisorEmpNo = req.user.assignedEmpNo ? parseInt(req.user.assignedEmpNo) : null;
    if (await isSupervisorOf(supervisorEmpNo, targetEmpNo)) return true;
    const extraWorkPlaces = ROLE_EXTRA_WORK_PLACES[req.user.role];
    if (extraWorkPlaces) {
        const deptEmpNos = await getWorkPlaceEmpNos(extraWorkPlaces);
        if (deptEmpNos.includes(targetEmpNo)) return true;
    }
    if (isHrScopedRole(req.user.role) && await isInHrScope(req.user.role, targetEmpNo)) return true;
    return false;
}

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
                'assignedStore',
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
   LIST users (Admin sees everyone; any manager sees only the users
   under them, per PayEmp.Supervisor_No)
---------------------------------- */
router.get('/', requireAuth, requireManageUsers, async (req, res) => {
    try {
        let supervisedUsernames = null; // null = no restriction (admin/hr)
        if (!hasCompanyWideScope(req.user.role)) {
            const supervisedEmpNos = await getScopedEmpNos(req);
            if (supervisedEmpNos.length === 0) {
                return res.json({ success: true, users: [], total: 0, page: 1, pageSize: 50 });
            }
            // username is the empNo as a string for employee-linked accounts
            // (see POST '/' below) -- that's the only join key available
            // between InsUser (MySQL) and PayEmp (ERP SQL Server).
            supervisedUsernames = supervisedEmpNos.map(String);
        }

        // Was silently ignored — a duplicate, dead GET '/' handler further
        // down this file supported ?search=, but Express only ever dispatches
        // to the first matching route, so admin/Users.tsx's search box never
        // actually filtered anything server-side.
        const search = String(req.query.search || '').trim();
        const conditions = [];
        if (supervisedUsernames) conditions.push({ username: { [Op.in]: supervisedUsernames } });
        if (search) {
            conditions.push({
                [Op.or]: [
                    { username: { [Op.like]: `%${search}%` } },
                    { firstName: { [Op.like]: `%${search}%` } },
                    { lastName: { [Op.like]: `%${search}%` } },
                    { email: { [Op.like]: `%${search}%` } },
                ],
            });
        }
        const where = conditions.length ? { [Op.and]: conditions } : undefined;

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
                'assignedStore',
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
   CREATE user (Admin/HR: any employee company-wide; Manager: only their
   own reports; only an actual admin may assign an hr/admin role --
   see PRIVILEGED_ROLES/hasCompanyWideScope above)
---------------------------------- */
router.post('/', requireAuth, requireManageUsers, async (req, res) => {
    try {
        const { empNo, role = 'installation_employee', teamId: bodyTeamId, password: bodyPassword, assignedStore } = req.body;
        const isAdmin = req.user.role === 'admin';

        if (!isAdmin && PRIVILEGED_ROLES.includes(role)) {
            return res.status(403).json({ success: false, message: 'Only an admin can assign this role' });
        }
        if (!isAdmin && !isRoleAssignable(req.user.role, role)) {
            return res.status(403).json({ success: false, message: 'You are not allowed to assign this role' });
        }

        if (!hasCompanyWideScope(req.user.role)) {
            // Managers can only create accounts linked to a real employee
            // they supervise -- the free-form username/password path below
            // has no employee link to scope against, so it stays
            // admin/hr-only.
            if (!empNo) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            const allowed = await isInManagerScope(req, parseInt(empNo));
            if (!allowed) {
                return res.status(403).json({ success: false, message: 'You can only create accounts for employees who report to you' });
            }
        }

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
            assignedStore: assignedStore ? Number(assignedStore) : null,
            active: true,
        });

        await UserAccountAudit.create({
            targetUserId: user.userId,
            targetUsername: user.username,
            action: 'created',
            newValue: role,
            performedByUserId: req.user.userId,
        });

        res.status(201).json({ success: true, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to create user' });
    }
});


/* ----------------------------------
   UPDATE user (Admin/HR: anyone company-wide; Self: own profile fields;
   Manager: users under them, minus hr/admin fields and accounts --
   see PRIVILEGED_ROLES). Only an actual admin may touch an existing
   hr/admin account or grant those roles -- HR's company-wide scope
   covers onboarding, not managing other HR/admin accounts.
---------------------------------- */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const isAdmin = req.user.role === 'admin';
        const isSelf = req.user.userId === Number(id);
        const hasScope = hasCompanyWideScope(req.user.role);

        // Not applied as router-level middleware like the other endpoints
        // here (see requireManageUsers above) -- profile.tsx calls this
        // same endpoint for every account editing its OWN profile, so a
        // blanket gate would lock ordinary employees out of that. Only
        // touching *someone else's* account needs the permission.
        if (!isSelf && !isAdmin) {
            const granted = await getPermissionsForRole(req.user.role);
            if (!granted.includes(PERMISSIONS.USERS_MANAGE)) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        const user = await User.findByPk(id);
        if (!user)
            return res.status(404).json({ success: false, message: 'User not found' });

        let isManagerOfTarget = false;
        if (!hasScope && !isSelf) {
            // A manager may never touch an existing hr/admin account, even
            // if PayEmp.Supervisor_No happens to say they supervise that
            // person -- only an actual admin can manage privileged accounts.
            if (PRIVILEGED_ROLES.includes(user.role)) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            const targetEmpNo = Number(user.username);
            isManagerOfTarget = !isNaN(targetEmpNo) && await isInManagerScope(req, targetEmpNo);
            if (!isManagerOfTarget) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }
        // hr touching an existing admin/hr account is still blocked, even
        // though hr has company-wide scope for ordinary employees.
        if (hasScope && !isAdmin && !isSelf && PRIVILEGED_ROLES.includes(user.role)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const {
            firstName,
            lastName,
            email,
            avatarUrl,
            role,
            teamId,
            assignedStore,
            active
        } = req.body;

        // Captured before mutation -- see the UserAccountAudit writes
        // below (after save), only for the security/privilege-relevant
        // fields (role, active). Not firstName/lastName/email/avatarUrl --
        // self-service profile edits aren't audit-worthy.
        const previousRole = user.role;
        const previousActive = user.active;

        if (firstName !== undefined) user.firstName = firstName;
        if (lastName !== undefined) user.lastName = lastName;
        if (email !== undefined) user.email = email;
        if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

        // Fields a manager/hr can also set for reports they're allowed to
        // touch, not just admin
        if (hasScope || isManagerOfTarget) {
            if (role !== undefined) {
                if (!isAdmin && PRIVILEGED_ROLES.includes(role)) {
                    return res.status(403).json({ success: false, message: 'Only an admin can assign this role' });
                }
                if (!isAdmin && !isRoleAssignable(req.user.role, role)) {
                    return res.status(403).json({ success: false, message: 'You are not allowed to assign this role' });
                }
                user.role = role;
            }
            if (teamId !== undefined) user.teamId = teamId;
            if (assignedStore !== undefined) user.assignedStore = assignedStore === null ? null : Number(assignedStore);
            if (active !== undefined) user.active = active;
        }

        await user.save();

        if (previousRole !== user.role) {
            await UserAccountAudit.create({
                targetUserId: user.userId,
                targetUsername: user.username,
                action: 'role_changed',
                oldValue: previousRole,
                newValue: user.role,
                performedByUserId: req.user.userId,
            });
        }
        if (previousActive !== user.active) {
            await UserAccountAudit.create({
                targetUserId: user.userId,
                targetUsername: user.username,
                action: user.active ? 'activated' : 'deactivated',
                performedByUserId: req.user.userId,
            });
        }

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

        await UserAccountAudit.create({
            targetUserId: user.userId,
            targetUsername: user.username,
            action: 'password_reset',
            performedByUserId: req.user.userId,
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
});

/* ----------------------------------
   BULK actions (Admin only)
   Deliberately admin-only rather than replicating PATCH /:id's nuanced
   self/manager-scope/hr-scope authorization for a multi-target operation --
   a bulk action is inherently higher blast-radius, and delete/reset-
   password are already admin-only regardless of that single-row
   flexibility. Every affected user still gets its own UserAccountAudit
   row (not one combined "bulk" entry) so the audit trail reads exactly
   like N individual admin actions that happened to run together.
---------------------------------- */
const MAX_BULK_USER_IDS = 200;

function parseBulkUserIds(body, req) {
    const ids = Array.isArray(body?.userIds)
        ? [...new Set(body.userIds.map(Number).filter((n) => Number.isInteger(n)))]
        : [];
    if (ids.length === 0 || ids.length > MAX_BULK_USER_IDS) return null;
    // Never let an admin bulk-deactivate/role-change/delete their own
    // account via a batch selection -- easy to select accidentally, and
    // unlike a single deliberate self-edit this has no confirmation step
    // naming just that one account.
    return ids.filter((id) => id !== req.user.userId);
}

router.patch('/bulk/active', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ids = parseBulkUserIds(req.body, req);
        if (ids === null) {
            return res.status(400).json({ success: false, message: `userIds must be a non-empty array of up to ${MAX_BULK_USER_IDS} ids` });
        }
        const active = !!req.body.active;
        const skippedSelf = Array.isArray(req.body.userIds) && req.body.userIds.map(Number).includes(req.user.userId);

        const users = await User.findAll({ where: { userId: ids } });
        let updated = 0;
        for (const user of users) {
            if (user.active === active) continue;
            user.active = active;
            await user.save();
            await UserAccountAudit.create({
                targetUserId: user.userId,
                targetUsername: user.username,
                action: active ? 'activated' : 'deactivated',
                performedByUserId: req.user.userId,
            });
            updated++;
        }
        res.json({ success: true, updated, skippedSelf });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to update users' });
    }
});

router.patch('/bulk/role', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ids = parseBulkUserIds(req.body, req);
        if (ids === null) {
            return res.status(400).json({ success: false, message: `userIds must be a non-empty array of up to ${MAX_BULK_USER_IDS} ids` });
        }
        const { role } = req.body;
        if (!role || typeof role !== 'string') {
            return res.status(400).json({ success: false, message: 'role is required' });
        }
        const skippedSelf = Array.isArray(req.body.userIds) && req.body.userIds.map(Number).includes(req.user.userId);

        const users = await User.findAll({ where: { userId: ids } });
        let updated = 0;
        for (const user of users) {
            if (user.role === role) continue;
            const previousRole = user.role;
            user.role = role;
            await user.save();
            await UserAccountAudit.create({
                targetUserId: user.userId,
                targetUsername: user.username,
                action: 'role_changed',
                oldValue: previousRole,
                newValue: role,
                performedByUserId: req.user.userId,
            });
            updated++;
        }
        res.json({ success: true, updated, skippedSelf });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to update users' });
    }
});

router.delete('/bulk', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ids = parseBulkUserIds(req.body, req);
        if (ids === null) {
            return res.status(400).json({ success: false, message: `userIds must be a non-empty array of up to ${MAX_BULK_USER_IDS} ids` });
        }
        const skippedSelf = Array.isArray(req.body.userIds) && req.body.userIds.map(Number).includes(req.user.userId);

        const users = await User.findAll({ where: { userId: ids } });
        let deleted = 0;
        for (const user of users) {
            const { userId, username, role } = user;
            await user.destroy();
            await UserAccountAudit.create({
                targetUserId: userId,
                targetUsername: username,
                action: 'deleted',
                oldValue: role,
                performedByUserId: req.user.userId,
            });
            deleted++;
        }
        res.json({ success: true, deleted, skippedSelf });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to delete users' });
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

        // Captured before destroy() -- targetUserId won't resolve to a
        // real account anymore afterward, so targetUsername/oldValue (the
        // role they held) are the only record left of who this was.
        const { userId, username, role } = user;
        await user.destroy();

        await UserAccountAudit.create({
            targetUserId: userId,
            targetUsername: username,
            action: 'deleted',
            oldValue: role,
            performedByUserId: req.user.userId,
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
});


// Admin: every unassigned employee company-wide (unchanged). Manager
// (non-admin): only their own reports who don't have an account yet --
// otherwise a manager could enroll anyone, defeating the whole point of
// scoping create-user access to "employees under them."
router.get('/employees', requireAuth, async (req, res) => {
    try {
        const { search = '' } = req.query;

        let supervisedEmpNos = null;
        if (!hasCompanyWideScope(req.user.role)) {
            supervisedEmpNos = await getScopedEmpNos(req);
            if (supervisedEmpNos.length === 0) {
                return res.json({ success: true, employees: [] });
            }
        }

        // 1️⃣ get existing usernames (empNo)
        const existingUsers = await User.findAll({
            attributes: ['username'],
        });

        const usedEmpNos = existingUsers
            .map(u => Number(u.username))
            .filter(n => !isNaN(n));

        const pool = await getSqlPool('erp');
        const sqlDB = process.env.MSSQL1_DB;

        // CORRECTED: this used to also filter to Work_place='7200'
        // (Installation Department only) and exclude job_code 191 --
        // both removed per explicit direction, since any manager company-
        // wide (not just Installation) needs to see their own reports here,
        // and there was no clear reason left to exclude a specific job code
        // once the department restriction itself was wrong.
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
        `;

        if (usedEmpNos.length) {
            query += ` AND e.Emp_num NOT IN (${usedEmpNos.join(',')})`;
        }

        if (supervisedEmpNos) {
            query += ` AND e.Emp_num IN (${supervisedEmpNos.length ? supervisedEmpNos.join(',') : 'NULL'})`;
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
