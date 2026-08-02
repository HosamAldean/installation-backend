// backend/routes/leads.js
// Petra ERP — Leads module. See Migration Blueprint §07 "Offers" (leads
// listed as its own page). Only 25 live rows -- a lightly-used feature,
// kept simple. Same roles as Offers.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelize2PetraErp } from '../config/db.js';
import { Lead } from '../models/Lead.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.PETRA_ERP_LEADS));

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

// GET /api/leads?page=&pageSize=&q=
router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const conditions = ['1=1'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.q) { conditions.push('l.leadName LIKE :q'); replacements.q = `%${req.query.q}%`; }
    const whereSql = conditions.join(' AND ');

    const leads = await sequelize2PetraErp.query(
        `SELECT l.*, u.firstName AS assignToFirstName, u.lastName AS assignToLastName
           FROM leads l
           LEFT JOIN InsUser u ON l.assignToId = u.userId
          WHERE ${whereSql}
          ORDER BY l.leadId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        `SELECT COUNT(*) AS total FROM leads l WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, leads });
});

// GET /api/leads/:id
router.get('/:id', async (req, res) => {
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Not found' });
    res.json(lead);
});

// POST /api/leads  { leadName, leadDate, ... }
router.post('/', async (req, res) => {
    if (!req.body.leadName?.trim() || !req.body.leadDate) {
        return res.status(400).json({ message: 'leadName and leadDate are required' });
    }
    const lead = await Lead.create(whitelist(Lead, req.body, ['leadId']));
    res.status(201).json(lead);
});

// PATCH /api/leads/:id
router.patch('/:id', async (req, res) => {
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Not found' });
    await lead.update(whitelist(Lead, req.body, ['leadId']));
    res.json(lead);
});

export default router;
