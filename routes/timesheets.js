// backend/routes/timesheets.js
// Petra ERP — Timesheets module (919 live rows). See Migration Blueprint
// §07 "Offers" (timesheets listed as its own page). Same roles as Offers.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { sequelize2PetraErp } from '../config/db.js';
import { TimeSheet } from '../models/TimeSheet.js';

const router = express.Router();
router.use(authenticateToken, authorizeRoles('sales', 'sales_manager', 'admin'));

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

// GET /api/timesheets?userId=&projectId=&page=&pageSize=
router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const conditions = ['1=1'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.userId) { conditions.push('t.userId = :userId'); replacements.userId = req.query.userId; }
    if (req.query.projectId) { conditions.push('t.projectId = :projectId'); replacements.projectId = req.query.projectId; }
    const whereSql = conditions.join(' AND ');

    const timesheets = await sequelize2PetraErp.query(
        `SELECT t.*, u.firstName AS userFirstName, u.lastName AS userLastName, p.projectName
           FROM timeSheet t
           LEFT JOIN InsUser u ON t.userId = u.userId
           LEFT JOIN project p ON t.projectId = p.projectId
          WHERE ${whereSql}
          ORDER BY t.timeSheetId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        `SELECT COUNT(*) AS total FROM timeSheet t WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, timesheets });
});

// POST /api/timesheets  { timeSheetTaskDesc, timeSheetStartTime, timeSheetEndTime, projectId?, offerId? }
router.post('/', async (req, res) => {
    if (!req.body.timeSheetStartTime || !req.body.timeSheetEndTime) {
        return res.status(400).json({ message: 'timeSheetStartTime and timeSheetEndTime are required' });
    }
    const timeSheet = await TimeSheet.create({
        ...whitelist(TimeSheet, req.body, ['timeSheetId']),
        userId: req.body.userId ?? req.user.userId,
    });
    res.status(201).json(timeSheet);
});

// PATCH /api/timesheets/:id
router.patch('/:id', async (req, res) => {
    const timeSheet = await TimeSheet.findByPk(req.params.id);
    if (!timeSheet) return res.status(404).json({ message: 'Not found' });
    await timeSheet.update(whitelist(TimeSheet, req.body, ['timeSheetId']));
    res.json(timeSheet);
});

export default router;
