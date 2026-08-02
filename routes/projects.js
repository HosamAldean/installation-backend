// backend/routes/projects.js
// Petra ERP — Projects module. See Migration Blueprint §07 "Projects".
// Upgrades IIT_Petra.project from the read-only LEFT JOIN used elsewhere
// (followUp.js, instOrders.js, installationRequests.js) into a real
// resource. Read access is intentionally wider than write access — other
// Petra ERP roles and installation_manager need to look projects up, but
// only project_manager/admin create or edit them.
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { Project } from '../models/Project.js';
import { ProjectTeam } from '../models/ProjectTeam.js';

const router = express.Router();
router.use(authenticateToken);

const canAccess = requirePermission(PERMISSIONS.PETRA_ERP_PROJECTS);

// GET /api/projects?page=&pageSize=&q=&statusId=&typeId=
router.get('/', canAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const q = String(req.query.q || '').trim();

    const where = {};
    if (q) {
        where[Op.or] = [
            { projectName: { [Op.like]: `%${q}%` } },
            { projectNo: { [Op.like]: `%${q}%` } },
        ];
    }
    if (req.query.statusId) where.statusId = req.query.statusId;
    if (req.query.typeId) where.typeId = req.query.typeId;

    const { count, rows } = await Project.findAndCountAll({
        where,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        order: [['projectId', 'DESC']],
    });
    res.json({ total: count, projects: rows });
});

// GET /api/projects/:id
router.get('/:id', canAccess, async (req, res) => {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Not found' });
    res.json(project);
});

// POST /api/projects
router.post('/', canAccess, async (req, res) => {
    const { projectName, projectNo } = req.body;
    if (!projectName || !String(projectName).trim()) {
        return res.status(400).json({ message: 'projectName is required' });
    }
    const attrs = Object.keys(Project.getAttributes()).filter((a) => a !== 'projectId');
    const values = {};
    for (const a of attrs) if (req.body[a] !== undefined) values[a] = req.body[a];

    try {
        const project = await Project.create(values);
        res.status(201).json(project);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'projectNo already exists' });
        }
        console.error('Error creating project:', err);
        res.status(500).json({ message: 'Failed to create project' });
    }
});

// PATCH /api/projects/:id
router.patch('/:id', canAccess, async (req, res) => {
    const project = await Project.findByPk(req.params.id);
    if (!project) return res.status(404).json({ message: 'Not found' });

    const attrs = Object.keys(Project.getAttributes()).filter((a) => a !== 'projectId');
    const updates = {};
    for (const a of attrs) if (req.body[a] !== undefined) updates[a] = req.body[a];

    try {
        await project.update(updates);
        res.json(project);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'projectNo already exists' });
        }
        console.error('Error updating project:', err);
        res.status(500).json({ message: 'Failed to update project' });
    }
});

// GET /api/projects/:id/team
router.get('/:id/team', canAccess, async (req, res) => {
    const team = await ProjectTeam.findAll({ where: { projectId: req.params.id } });
    res.json({ team });
});

// POST /api/projects/:id/team  { userId, teamClassId }
router.post('/:id/team', canAccess, async (req, res) => {
    const { userId, teamClassId } = req.body;
    if (!userId || teamClassId === undefined) {
        return res.status(400).json({ message: 'userId and teamClassId are required' });
    }
    const member = await ProjectTeam.create({
        projectId: req.params.id,
        userId,
        teamClassId,
    });
    res.status(201).json(member);
});

// DELETE /api/projects/:id/team/:userId
router.delete('/:id/team/:userId', canAccess, async (req, res) => {
    const deleted = await ProjectTeam.destroy({
        where: { projectId: req.params.id, userId: req.params.userId },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'removed' });
});

export default router;
