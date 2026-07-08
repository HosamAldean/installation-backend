// backend/routes/api.js
import express from 'express';
import { sequelize } from '../config/db.js'; // adjust to your DB config
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
const router = express.Router();

// Health check
router.get('/health', (req, res) => res.json({ ok: true }));

// Dashboard stats — previously unauthenticated, exposing internal
// user/team/project counts to any caller. Only called from the
// manager/admin-gated Dashboard pages.
router.get('/stats', authenticateToken, authorizeRoles('installation_manager', 'admin'), async (req, res) => {
    try {
        const [[{ userCount }]] = await sequelize.query(`SELECT COUNT(*) AS userCount FROM InsUser`);
        const [[{ teamCount }]] = await sequelize.query(`SELECT COUNT(*) AS teamCount FROM instTeams`);
        const [[{ assignedTeamCount }]] = await sequelize.query(`
            SELECT COUNT(DISTINCT team_id) AS assignedTeamCount
            FROM instTeamMembers
        `);
        const [[{ projectCount }]] = await sequelize.query(`SELECT COUNT(*) AS projectCount FROM instReqMaster`);
        // Real estate projects with at least one installation request —
        // previously "Projects" was a hardcoded literal (24) with no query
        // behind it at all, shown as-is on the dashboard regardless of
        // actual data. Units/Stores/Companies were the same (hardcoded 2/2/1)
        // but were never actually rendered anywhere in the frontend, so
        // they're just removed rather than replaced.
        const [[{ distinctProjectCount }]] = await sequelize.query(
            `SELECT COUNT(DISTINCT projectId) AS distinctProjectCount FROM instReqMaster`
        );

        res.json({
            success: true,
            stats: {
                users: userCount,
                teams: teamCount,
                // Was `teamCount + teamCount - assignedTeamCount` (double
                // counting teamCount), which could report more "available"
                // teams than actually exist.
                avalaibleTeams: teamCount - assignedTeamCount,
                bundingproject: projectCount,
                Projects: distinctProjectCount,
            }

        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
});

export default router;
