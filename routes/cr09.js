// backend/routes/cr09.js
// Petra ERP — CR09 module: project-level specification presets. See
// Migration Blueprint §07 "Control Sheet" (CR09/CR09Detail). Real table
// names are CR09Master (one row per project) and CR09Details (94k+ rows,
// tied to a specific masterControl.rowId) -- not "CR09"/"CR09Detail" as
// guessed from the legacy PHP class names, verified via SHOW TABLES/
// COLUMNS before writing this.
//
// Deliberately NOT built here (further deferral, on top of what
// routes/controlSheet.js and routes/offers.js already deferred): the
// unit-tagging tables motorUnitCR09/shutterBoxUnitCR09/
// shutterCoverUnitCR09/shutterUnitCR09 (which contract-unit IDs have a
// motor/shutter-box/shutter-cover/shutter feature) -- four more near-
// identical simple tables, secondary to the two core CR09 tables.
//
// Same roles as Control Sheet: project_manager/admin write,
// +installation_manager read.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { sequelize2PetraErp } from '../config/db.js';
import { CR09Master } from '../models/CR09Master.js';
import { CR09Details } from '../models/CR09Details.js';

const router = express.Router();
router.use(authenticateToken);

const canWrite = authorizeRoles('project_manager', 'admin');
const canRead = authorizeRoles('project_manager', 'installation_manager', 'admin');

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

/* ---------------- Master (project-level preset) ---------------- */

// GET /api/cr09/master?projectId=
router.get('/master', canRead, async (req, res) => {
    if (!req.query.projectId) return res.status(400).json({ message: 'projectId is required' });
    const master = await CR09Master.findOne({ where: { projectId: req.query.projectId } });
    res.json(master);
});

// POST /api/cr09/master  { projectId, colorInfoId?, ... } -- one per project
router.post('/master', canWrite, async (req, res) => {
    if (!req.body.projectId) return res.status(400).json({ message: 'projectId is required' });
    const existing = await CR09Master.findOne({ where: { projectId: req.body.projectId } });
    if (existing) return res.status(409).json({ message: 'A CR09 preset already exists for this project' });
    const master = await CR09Master.create(whitelist(CR09Master, req.body, ['CR09Id']));
    res.status(201).json(master);
});

// PATCH /api/cr09/master/:id
router.patch('/master/:id', canWrite, async (req, res) => {
    const master = await CR09Master.findByPk(req.params.id);
    if (!master) return res.status(404).json({ message: 'Not found' });
    await master.update(whitelist(CR09Master, req.body, ['CR09Id', 'projectId']));
    res.json(master);
});

/* ---------------- Details (per-unit) ---------------- */

// GET /api/cr09/details?projectId=&page=&pageSize=
router.get('/details', canRead, async (req, res) => {
    if (!req.query.projectId) return res.status(400).json({ message: 'projectId is required' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

    const details = await sequelize2PetraErp.query(
        `SELECT d.*, m.unitIdContract, m.unitIdDetail, g.glassName
           FROM CR09Details d
           LEFT JOIN masterControl m ON d.rowId = m.rowId
           LEFT JOIN CR09dGlass g ON d.glassId = g.glassId
          WHERE d.projectId = :projectId
          ORDER BY d.CR09DetailId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements: { projectId: req.query.projectId, limit: pageSize, offset: (page - 1) * pageSize }, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        'SELECT COUNT(*) AS total FROM CR09Details WHERE projectId = :projectId',
        { replacements: { projectId: req.query.projectId }, type: QueryTypes.SELECT },
    );
    res.json({ total, details });
});

// POST /api/cr09/details  { projectId, rowId?, glassId?, aluminumColorId?, ... }
router.post('/details', canWrite, async (req, res) => {
    if (!req.body.projectId) return res.status(400).json({ message: 'projectId is required' });
    const detail = await CR09Details.create(whitelist(CR09Details, req.body, ['CR09DetailId']));
    res.status(201).json(detail);
});

// PATCH /api/cr09/details/:id
router.patch('/details/:id', canWrite, async (req, res) => {
    const detail = await CR09Details.findByPk(req.params.id);
    if (!detail) return res.status(404).json({ message: 'Not found' });
    await detail.update(whitelist(CR09Details, req.body, ['CR09DetailId', 'projectId']));
    res.json(detail);
});

export default router;
