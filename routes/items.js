// ------------------------------------------------------
// backend/routes/items.js
// ------------------------------------------------------
import express from 'express';
import { Item } from '../models/Item.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';


const router = express.Router();


// List items with simple pagination
router.get('/', authenticateToken, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;


    const { count, rows } = await Item.findAndCountAll({ limit: pageSize, offset, order: [['createdAt', 'DESC']] });
    res.json({ total: count, items: rows });
});


// Get single item
router.get('/:id', authenticateToken, async (req, res) => {
    const item = await Item.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
});


// Create item (admin or manager)
router.post('/', authenticateToken, authorizeRoles('admin', 'manager'), async (req, res) => {
    const { code, name, description, qty } = req.body;
    if (!code || !String(code).trim() || !name || !String(name).trim()) {
        return res.status(400).json({ message: 'code and name are required' });
    }
    if (qty !== undefined && (typeof qty !== 'number' || qty < 0)) {
        return res.status(400).json({ message: 'qty must be a non-negative number' });
    }
    try {
        const item = await Item.create({ code, name, description, qty: qty || 0 });
        res.status(201).json(item);
    } catch (err) {
        // The findOne-then-create check this replaced was a check-then-act
        // race (two concurrent requests with the same code could both pass
        // the check before either insert completed) — rely on the unique
        // constraint itself and translate its error into the same 409
        // instead of letting it fall through as a generic 500.
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'code already exists' });
        }
        console.error('Error creating item:', err);
        res.status(500).json({ message: 'Failed to create item' });
    }
});


// Update item
router.put('/:id', authenticateToken, authorizeRoles('admin', 'manager'), async (req, res) => {
    const item = await Item.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });

    const { code, name, description, qty } = req.body;
    if (qty !== undefined && (typeof qty !== 'number' || qty < 0)) {
        return res.status(400).json({ message: 'qty must be a non-negative number' });
    }
    // Previously passed the whole request body straight to .update(),
    // letting a caller push arbitrary columns (createdAt, etc.) instead of
    // only the fields actually meant to be editable.
    const updates = {};
    if (code !== undefined) updates.code = code;
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (qty !== undefined) updates.qty = qty;

    try {
        await item.update(updates);
        res.json(item);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'code already exists' });
        }
        console.error('Error updating item:', err);
        res.status(500).json({ message: 'Failed to update item' });
    }
});


// Delete item (soft-delete would be better)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
    const item = await Item.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });
    await item.destroy();
    res.json({ message: 'deleted' });
});


export default router;