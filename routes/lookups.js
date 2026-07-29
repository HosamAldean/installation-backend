// backend/routes/lookups.js
// One generic CRUD surface for the ~20 Petra reference tables registered
// in models/lookupModels.js. See Migration Blueprint §07 "Lookups".
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken, authorizeReadWrite } from '../middleware/auth.js';
import { LOOKUP_REGISTRY, LOOKUP_TYPES } from '../models/lookupModels.js';

const router = express.Router();

// Editing reference data is admin-only, matching Migration Blueprint §07's
// "Roles: admin" -- but *reading* it can't be, since Orders/Cash Flow (and
// any future Petra ERP form) need these for their own dropdowns (order
// type/status, payment type, bank, ...). Originally admin-only for both;
// found broken when Cash Flow's payment-type/bank dropdowns needed this
// and every other Petra ERP role would have 403'd reading it. 'user' is
// also included here (unlike other Petra ERP routes) specifically so the
// admin+testuser soft launch (Migration Blueprint Rev F) can exercise
// these dropdowns -- testuser's actual role is the generic 'user', not
// one of the Petra ERP roles. Reference data is read-only and has no PII,
// so this is a low-risk broadening; worth revisiting once the soft launch
// ends and access opens to the real Petra ERP roles.
router.use(
    authenticateToken,
    authorizeReadWrite(
        ['sales', 'sales_manager', 'accounting', 'project_manager', 'user', 'admin'],
        ['admin'],
    ),
);

// `:type` is validated against the fixed registry below on every route —
// this is a generic table proxy, so that allow-list is what stands in for
// per-table route definitions, not user input reaching a table name.
router.param('type', (req, res, next, type) => {
    const entry = LOOKUP_REGISTRY[type];
    if (!entry) {
        return res.status(404).json({ message: `Unknown lookup type '${type}'`, validTypes: LOOKUP_TYPES });
    }
    req.lookup = entry;
    next();
});

// GET /api/lookups  — list of valid types, for building the admin picker
router.get('/', (req, res) => {
    res.json({ types: LOOKUP_TYPES });
});

// GET /api/lookups/:type?page=&pageSize=&q=
router.get('/:type', async (req, res) => {
    const { model, nameField } = req.lookup;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const q = String(req.query.q || '').trim();

    const where = q ? { [nameField]: { [Op.like]: `%${q}%` } } : undefined;

    const { count, rows } = await model.findAndCountAll({
        where,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        order: [[nameField, 'ASC']],
    });
    res.json({ total: count, items: rows });
});

// GET /api/lookups/:type/:id
router.get('/:type/:id', async (req, res) => {
    const { model } = req.lookup;
    const row = await model.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    res.json(row);
});

// POST /api/lookups/:type
router.post('/:type', async (req, res) => {
    const { model, pkField } = req.lookup;
    // Never let the request body set the primary key on create — only
    // whitelist the model's real (non-PK) attributes.
    const attrs = Object.keys(model.getAttributes()).filter((a) => a !== pkField);
    const values = {};
    for (const a of attrs) if (req.body[a] !== undefined) values[a] = req.body[a];

    try {
        const row = await model.create(values);
        res.status(201).json(row);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A row with that value already exists' });
        }
        console.error('Error creating lookup row:', err);
        res.status(500).json({ message: 'Failed to create row' });
    }
});

// PATCH /api/lookups/:type/:id
router.patch('/:type/:id', async (req, res) => {
    const { model, pkField } = req.lookup;
    const row = await model.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });

    const attrs = Object.keys(model.getAttributes()).filter((a) => a !== pkField);
    const updates = {};
    for (const a of attrs) if (req.body[a] !== undefined) updates[a] = req.body[a];

    try {
        await row.update(updates);
        res.json(row);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A row with that value already exists' });
        }
        console.error('Error updating lookup row:', err);
        res.status(500).json({ message: 'Failed to update row' });
    }
});

// DELETE /api/lookups/:type/:id
router.delete('/:type/:id', async (req, res) => {
    const { model } = req.lookup;
    const row = await model.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    await row.destroy();
    res.json({ message: 'deleted' });
});

export default router;
