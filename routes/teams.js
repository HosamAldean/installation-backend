import express from 'express';
import { sequelize2, getSqlPool } from '../config/db.js';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();
// This entire router previously had no authentication at all — team
// creation/deletion, member assignment, and leader changes were reachable by
// anyone with network access. The frontend (EmployeeCardPage.tsx) is already
// gated to manager/admin via RoleProtectedRoute — mirror that here.
router.use(authenticateToken);
router.use(authorizeRoles('installation_manager', 'admin'));

/** -------------------------------------------------------
 *  🔧 Arabic Auto-Recovery (Fix double-encoded UTF-8 text)
 * -------------------------------------------------------- */
const fixArabic = (str) => {
    if (!str || typeof str !== 'string') return str;
    try {
        const buf = Buffer.from(str, 'binary');
        const utf = buf.toString('utf8');
        if (/[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي]/.test(utf)) return utf;
        return str;
    } catch {
        return str;
    }
};

const fixArabicFields = (row) => {
    if (!row) return row;
    const arabicFields = ['name', 'description'];
    arabicFields.forEach((key) => {
        if (row[key]) row[key] = fixArabic(row[key]);
    });
    return row;
};

/**
 * Create a new team
 */
router.post('/', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { name, description, leaderEmpNo } = req.body;
        if (!name) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'Team name required' });
        }

        const result = await sequelize2.query(
            'INSERT INTO instTeams (name, description, leader_emp_no, createdAt, updatedAt) VALUES (:name, :description, :leaderEmpNo, NOW(), NOW())',
            { replacements: { name, description, leaderEmpNo }, type: QueryTypes.INSERT, transaction: trx }
        );

        const teamId = result[0];

        if (leaderEmpNo) {
            await sequelize2.query(
                'INSERT INTO instTeamMembers (team_id, emp_no, is_leader) VALUES (:teamId, :empNo, 1)',
                { replacements: { teamId, empNo: leaderEmpNo }, transaction: trx }
            );
        }

        await trx.commit();
        res.json({ success: true, teamId });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error creating team:', err);
        res.status(500).json({ success: false, message: 'Server error creating team' });
    }
});

/**
 * List all teams
 */
router.get('/', async (req, res) => {
    try {
        const teams = await sequelize2.query(
            'SELECT * FROM instTeams ORDER BY createdAt DESC',
            { type: QueryTypes.SELECT }
        );

        const mapped = teams.map(fixArabicFields);
        res.json({ success: true, data: mapped });
    } catch (err) {
        console.error('❌ Error fetching teams:', err);
        res.status(500).json({ success: false, message: 'Server error fetching teams' });
    }
});

/**
 * Update team
 */
router.put('/:teamId', async (req, res) => {
    try {
        const { teamId } = req.params;
        let { name, description, leaderEmpNo } = req.body;

        if (!name) return res.status(400).json({ success: false, message: 'Team name required' });

        name = fixArabic(name);
        description = fixArabic(description);

        const [, updateMeta] = await sequelize2.query(
            'UPDATE instTeams SET name = :name, description = :description, leader_emp_no = :leaderEmpNo, updatedAt = NOW() WHERE id = :teamId',
            { replacements: { teamId, name, description, leaderEmpNo } }
        );
        if (!updateMeta?.affectedRows) {
            return res.status(404).json({ success: false, message: 'Team not found' });
        }

        if (leaderEmpNo) {
            // Check whether the new leader is already a member BEFORE the
            // broad UPDATE below — that UPDATE's affectedRows reflects every
            // member whose is_leader value changed (including existing
            // members losing leader status), not whether the new leader's
            // own row exists, so it can't be used to detect this case.
            const existing = await sequelize2.query(
                'SELECT 1 FROM instTeamMembers WHERE team_id = :teamId AND emp_no = :leaderEmpNo',
                { replacements: { teamId, leaderEmpNo }, type: QueryTypes.SELECT }
            );

            await sequelize2.query(
                `UPDATE instTeamMembers
                 SET is_leader = CASE WHEN emp_no = :leaderEmpNo THEN 1 ELSE 0 END
                 WHERE team_id = :teamId`,
                { replacements: { teamId, leaderEmpNo } }
            );

            // The new leader wasn't already a team member — insert them
            // explicitly, same fallback used by POST /:teamId/members.
            // Without this, a leader reassigned to someone not yet on the
            // roster would silently vanish from it instead of being added.
            if (!existing.length) {
                await sequelize2.query(
                    'INSERT INTO instTeamMembers (team_id, emp_no, is_leader) VALUES (:teamId, :leaderEmpNo, 1)',
                    { replacements: { teamId, leaderEmpNo } }
                );
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error updating team:', err);
        res.status(500).json({ success: false, message: 'Server error updating team' });
    }
});

/**
 * Assign multiple employees to a team (with leader)
 *
 * Wrapped in a transaction: the old delete+reinsert loop previously had no
 * rollback path, so a failure partway through (bad empNo, DB hiccup) left the
 * roster with the old members deleted but only some of the new ones
 * inserted. It also always ran even when empNos was empty, which is the
 * intended way to clear a team's roster to zero members — the frontend must
 * always call this endpoint on save, not skip it when nothing is checked.
 */
router.post('/:teamId/members', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { teamId } = req.params;
        const { empNos, leaderEmpNo } = req.body;

        if (!Array.isArray(empNos)) {
            await trx.rollback();
            return res.status(400).json({ success: false, message: 'empNos must be an array' });
        }

        await sequelize2.query(
            'DELETE FROM instTeamMembers WHERE team_id = :teamId',
            { replacements: { teamId }, transaction: trx }
        );

        for (const empNo of empNos) {
            await sequelize2.query(
                'INSERT INTO instTeamMembers (team_id, emp_no, is_leader) VALUES (:teamId, :empNo, :isLeader)',
                { replacements: { teamId, empNo, isLeader: empNo === leaderEmpNo ? 1 : 0 }, transaction: trx }
            );
        }

        // Ensure leader is also inserted if not in empNos
        if (leaderEmpNo && !empNos.includes(leaderEmpNo)) {
            await sequelize2.query(
                'INSERT INTO instTeamMembers (team_id, emp_no, is_leader) VALUES (:teamId, :leaderEmpNo, 1)',
                { replacements: { teamId, leaderEmpNo }, transaction: trx }
            );
        }

        await trx.commit();
        res.json({ success: true });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error assigning members:', err);
        res.status(500).json({ success: false, message: 'Server error assigning members' });
    }
});


/**
 * Remove a member
 */
router.delete('/:teamId/members/:empNo', async (req, res) => {
    try {
        const { teamId, empNo } = req.params;

        const [, meta] = await sequelize2.query(
            'DELETE FROM instTeamMembers WHERE team_id = :teamId AND emp_no = :empNo',
            { replacements: { teamId, empNo } }
        );
        if (!meta?.affectedRows) {
            return res.status(404).json({ success: false, message: 'Member not found on this team' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error removing member:', err);
        res.status(500).json({ success: false, message: 'Server error removing member' });
    }
});

/**
 * List team members
 */
router.get('/:teamId/members', async (req, res) => {
    try {
        const { teamId } = req.params;

        const members = await sequelize2.query(
            'SELECT emp_no, is_leader FROM instTeamMembers WHERE team_id = :teamId',
            { replacements: { teamId }, type: QueryTypes.SELECT }
        );

        if (members.length === 0) return res.json({ success: true, data: [] });

        const pool = await getSqlPool('erp');
        const empIds = members.map(m => m.emp_no);
        const placeholders = empIds.map((_, i) => `@emp${i}`).join(',');
        const request = pool.request();
        empIds.forEach((id, i) => request.input(`emp${i}`, id));

        const sqlDB = process.env.MSSQL1_DB;

        const result = await request.query(`
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                e.Job_code,
                e.Work_status,
                j.job_Desc
            FROM ${sqlDB}.dbo.PayEmp AS e
            LEFT JOIN ${sqlDB}.dbo.Pay_Job AS j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Emp_num IN (${placeholders})
        `);

        const finalMembers = result.recordset.map(emp => {
            const member = members.find(m => m.emp_no === emp.empNo);
            return { ...emp, is_leader: member?.is_leader || 0 };
        });

        res.json({ success: true, data: finalMembers });
    } catch (err) {
        console.error('❌ Error fetching team members:', err);
        res.status(500).json({ success: false, message: 'Server error fetching team members' });
    }
});

/**
 * Delete a team
 *
 * Previously this bulk-deleted every instReqDet row assigned to the team —
 * instReqDet holds real installation-request LINE ITEMS (itemName, qty,
 * notes), not an assignment/join table, so deleting a team destroyed live
 * request data instead of just unassigning it. Now this mirrors
 * instOrders.js's per-item unassign: clear the assignment and the derived
 * order/step rows, but leave the underlying request line item intact
 * (assignedTeamId -> NULL) so it can be reassigned to another team.
 */
router.delete('/:teamId', async (req, res) => {
    const trx = await sequelize2.transaction();
    try {
        const { teamId } = req.params;

        const assignments = await sequelize2.query(
            `SELECT id, instReqDetId, instOrderId FROM IIT_Petra.instReqAssignments WHERE teamId = :teamId`,
            { replacements: { teamId }, type: QueryTypes.SELECT, transaction: trx }
        );

        const affectedOrderIds = new Set();
        const affectedMasterIds = new Set();

        for (const a of assignments) {
            await sequelize2.query(
                `DELETE FROM IIT_Petra.instOrderItems WHERE instOrderId = :orderId AND instReqDetId = :detId`,
                { replacements: { orderId: a.instOrderId, detId: a.instReqDetId }, transaction: trx }
            );
            await sequelize2.query(
                `DELETE FROM IIT_Petra.instReqAssignments WHERE id = :id`,
                { replacements: { id: a.id }, transaction: trx }
            );
            await sequelize2.query(
                `UPDATE IIT_Petra.instReqDet SET assignedTeamId = NULL WHERE instReqDetId = :id`,
                { replacements: { id: a.instReqDetId }, transaction: trx }
            );
            if (a.instOrderId) affectedOrderIds.add(a.instOrderId);

            const master = await sequelize2.query(
                `SELECT instReqMasterId FROM IIT_Petra.instReqDet WHERE instReqDetId = :id`,
                { replacements: { id: a.instReqDetId }, type: QueryTypes.SELECT, transaction: trx }
            );
            if (master[0]?.instReqMasterId) affectedMasterIds.add(master[0].instReqMasterId);
        }

        // Orders left with zero items after unassigning get cleaned up, same
        // as the single-item unassign path.
        for (const orderId of affectedOrderIds) {
            const remain = await sequelize2.query(
                `SELECT COUNT(*) AS cnt FROM IIT_Petra.instOrderItems WHERE instOrderId = :id`,
                { replacements: { id: orderId }, type: QueryTypes.SELECT, transaction: trx }
            );
            if (Number(remain[0].cnt) === 0) {
                await sequelize2.query(`DELETE FROM IIT_Petra.instOrders WHERE id = :id`, { replacements: { id: orderId }, transaction: trx });
            }
        }

        // Requests that were fully assigned may no longer be — revert status
        // so they show back up as needing assignment.
        for (const masterId of affectedMasterIds) {
            const totalItems = await sequelize2.query(`SELECT COUNT(*) AS total FROM IIT_Petra.instReqDet WHERE instReqMasterId = :id`, { replacements: { id: masterId }, type: QueryTypes.SELECT, transaction: trx });
            const assignedItems = await sequelize2.query(`SELECT COUNT(*) AS assigned FROM IIT_Petra.instReqAssignments a JOIN IIT_Petra.instReqDet d ON d.instReqDetId = a.instReqDetId WHERE d.instReqMasterId = :id`, { replacements: { id: masterId }, type: QueryTypes.SELECT, transaction: trx });
            if (Number(assignedItems[0].assigned) < Number(totalItems[0].total)) {
                await sequelize2.query(`UPDATE IIT_Petra.instReqMaster SET reqStatusId = 1 WHERE instReqMasterId = :id`, { replacements: { id: masterId }, transaction: trx });
            }
        }

        await sequelize2.query(
            'DELETE FROM instTeamMembers WHERE team_id = :teamId',
            { replacements: { teamId }, transaction: trx }
        );

        const [, deleteMeta] = await sequelize2.query(
            'DELETE FROM instTeams WHERE id = :teamId',
            { replacements: { teamId }, transaction: trx }
        );
        if (!deleteMeta?.affectedRows) {
            await trx.rollback();
            return res.status(404).json({ success: false, message: 'Team not found' });
        }

        await trx.commit();
        res.json({ success: true, unassignedItems: assignments.length });
    } catch (err) {
        await trx.rollback();
        console.error('❌ Error deleting team:', err);
        res.status(500).json({ success: false, message: 'Server error deleting team' });
    }
});

/**
 * GET /teams/employees
 * Returns list of employees eligible to be assigned to teams
 * Returns both:
 * - allEmployees: all available employees (Work_status = '1')
 * - eligibleLeaders: only those who can be leaders (Work_status = '1' AND Job_code <> '191')
 * Optional query param: excludeEmpNos (comma-separated) to exclude already assigned employees
 */
router.get('/employees', async (req, res) => {
    try {
        const pool = await getSqlPool('erp');
        const sqlDB = process.env.MSSQL1_DB;

        // Parse excludeEmpNos query param
        let excludeEmpNos = [];
        if (req.query.excludeEmpNos) {
            excludeEmpNos = req.query.excludeEmpNos
                .split(',')
                .map((v) => parseInt(v, 10))
                .filter(Boolean);
        }

        let query = `
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                e.Job_code,
                e.Work_status,
                e.Work_place,
                j.job_Desc
            FROM ${sqlDB}.dbo.PayEmp AS e
            LEFT JOIN ${sqlDB}.dbo.Pay_Job AS j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Work_status = '1'
              AND e.Work_place = '7200'
              
        `;

        if (excludeEmpNos.length) {
            const placeholders = excludeEmpNos.map((_, i) => `@emp${i}`).join(',');
            query += ` AND e.Emp_num NOT IN (${placeholders})`;
        }

        const request = pool.request();
        excludeEmpNos.forEach((id, i) => request.input(`emp${i}`, id));

        const result = await request.query(query);
        const allEmployees = result.recordset;

        const eligibleLeaders = allEmployees.filter(emp => emp.Job_code !== '191');

        res.json({ success: true, allEmployees, eligibleLeaders });
    } catch (err) {
        console.error('❌ Error fetching employees:', err);
        res.status(500).json({ success: false, message: 'Server error fetching employees' });
    }
});

/**
 * GET /teams/employees/leaders
 * Returns all eligible leaders, optionally excluding already-assigned employees
 * Query param: excludeEmpNos (comma-separated)
 */
router.get('/employees/leaders', async (req, res) => {
    try {
        const pool = await getSqlPool('erp');
        const sqlDB = process.env.MSSQL1_DB;

        // Parse excludeEmpNos query param
        let excludeEmpNos = [];
        if (req.query.excludeEmpNos) {
            excludeEmpNos = req.query.excludeEmpNos
                .toString()
                .split(',')
                .map(v => parseInt(v, 10))
                .filter(Boolean);
        }

        let query = `
            SELECT 
                e.Emp_num AS empNo,
                e.EmpEngName AS name_en,
                e.EmpName AS name_ar,
                e.Job_code,
                e.Work_status,
                e.Work_place,
                j.job_Desc
            FROM ${sqlDB}.dbo.PayEmp AS e
            LEFT JOIN ${sqlDB}.dbo.Pay_Job AS j
                ON e.Job_code = j.job_code AND j.Comp_num = '1'
            WHERE e.Work_status = '1'
              AND e.Work_place = '7200'
              AND e.Job_code <> '191'
        `;

        if (excludeEmpNos.length > 0) {
            const placeholders = excludeEmpNos.map((_, i) => `@emp${i}`).join(',');
            query += ` AND e.Emp_num NOT IN (${placeholders})`;
        }

        const request = pool.request();
        excludeEmpNos.forEach((id, i) => request.input(`emp${i}`, id));

        const result = await request.query(query);
        const eligibleLeaders = result.recordset;

        res.json({ success: true, eligibleLeaders });
    } catch (err) {
        console.error('❌ Error fetching eligible leaders:', err);
        res.status(500).json({ success: false, message: 'Server error fetching leaders' });
    }
});



export default router;
