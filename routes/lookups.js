// backend/routes/lookups.js
// One generic CRUD surface for the ~20 Petra reference tables registered
// in models/lookupModels.js. See Migration Blueprint §07 "Lookups".
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { LOOKUP_REGISTRY, LOOKUP_TYPES } from '../models/lookupModels.js';

const router = express.Router();

// View is admin-editable via the PermissionGrant table (see
// PERMISSIONS.LOOKUPS_VIEW) since Orders/Cash Flow (and any future Petra
// ERP form) need these for their own dropdowns (order type/status, payment
// type, bank, ...) and who needs that varies by ordinary business role.
// Editing reference data stays hardcoded admin-only on purpose, same as
// routes/permissions.js's own admin-only gate -- not made grantable, since
// reference/lookup data is shared company-wide and a bad edit here is
// higher-blast-radius than a bad edit to one's own module's data.
router.use(authenticateToken);
const requireView = requirePermission(PERMISSIONS.LOOKUPS_VIEW);
const requireEdit = authorizeRoles('admin');

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
router.get('/', requireView, (req, res) => {
    res.json({ types: LOOKUP_TYPES });
});

// GET /api/lookups/:type?page=&pageSize=&q=
router.get('/:type', requireView, async (req, res) => {
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
router.get('/:type/:id', requireView, async (req, res) => {
    const { model } = req.lookup;
    const row = await model.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    res.json(row);
});

// POST /api/lookups/:type
router.post('/:type', requireEdit, async (req, res) => {
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
router.patch('/:type/:id', requireEdit, async (req, res) => {
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
router.delete('/:type/:id', requireEdit, async (req, res) => {
    const { model } = req.lookup;
    const row = await model.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    await row.destroy();
    res.json({ message: 'deleted' });
});

export default router;
