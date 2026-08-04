// backend/routes/cashFlow.js
// Petra ERP — Cash Flow module (PH.4). See Migration Blueprint §07 "Cash
// Flow". A CashFlow row is a payment-stage entry for a project (e.g. "30%
// deposit"); actual payments against it live in cashFlowDetails. Narrower
// audience than Orders/Projects -- accounting + admin only, per the
// blueprint's "Roles: accounting, admin".
//
// Route order matters below: /notes and /expected are registered before
// the generic /:id so Express doesn't swallow them as an :id param.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelize2PetraErp } from '../config/db.js';
import { CashFlow } from '../models/CashFlow.js';
import { CashFlowDetails } from '../models/CashFlowDetails.js';
import { CashFlowNotes } from '../models/CashFlowNotes.js';
import { CashFlowExpected } from '../models/CashFlowExpected.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.PETRA_ERP_CASH_FLOW));

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

/* ---------------- Notes ---------------- */

// GET /api/cash-flow/notes?projectId=
router.get('/notes', async (req, res) => {
    if (!req.query.projectId) return res.status(400).json({ message: 'projectId is required' });
    const notes = await CashFlowNotes.findAll({
        where: { projectId: req.query.projectId },
        order: [['noteDate', 'DESC']],
    });
    res.json({ notes });
});

// POST /api/cash-flow/notes  { projectId, note }
router.post('/notes', async (req, res) => {
    if (!req.body.projectId || !req.body.note?.trim()) {
        return res.status(400).json({ message: 'projectId and note are required' });
    }
    try {
        const note = await CashFlowNotes.create({
            projectId: req.body.projectId,
            note: req.body.note,
            cashFlowNoteUserId: req.user.userId,
            noteDate: new Date(),
        });
        res.status(201).json(note);
    } catch (err) {
        console.error('Error creating cash flow note:', err);
        res.status(500).json({ message: 'Failed to create note' });
    }
});

/* ---------------- Expected amounts ---------------- */

// GET /api/cash-flow/expected?projectId=
router.get('/expected', async (req, res) => {
    if (!req.query.projectId) return res.status(400).json({ message: 'projectId is required' });
    const expected = await CashFlowExpected.findAll({
        where: { projectId: req.query.projectId },
        order: [['entryDate', 'DESC']],
    });
    res.json({ expected });
});

// POST /api/cash-flow/expected  { projectId, expectedAmount, dueDate?, note? }
router.post('/expected', async (req, res) => {
    if (!req.body.projectId || req.body.expectedAmount === undefined || req.body.expectedAmount === null) {
        return res.status(400).json({ message: 'projectId and expectedAmount are required' });
    }
    if (typeof req.body.expectedAmount !== 'number' || req.body.expectedAmount < 0) {
        return res.status(400).json({ message: 'expectedAmount must be a non-negative number' });
    }
    try {
        const entry = await CashFlowExpected.create({
            ...whitelist(CashFlowExpected, req.body, ['cashFlowExpectedId']),
            entryDate: new Date(),
        });
        res.status(201).json(entry);
    } catch (err) {
        console.error('Error creating expected amount:', err);
        res.status(500).json({ message: 'Failed to create expected amount entry' });
    }
});

/* ---------------- Cash Flow stage entries ---------------- */

// GET /api/cash-flow?projectId=&page=&pageSize=
router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const conditions = ['1=1'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.projectId) { conditions.push('cf.projectId = :projectId'); replacements.projectId = req.query.projectId; }
    const whereSql = conditions.join(' AND ');

    const rows = await sequelize2PetraErp.query(
        `SELECT cf.*, s.cashFlowStageName
           FROM cashFlow cf
           LEFT JOIN cashFlowStage s ON cf.cashFlowStageId = s.cashFlowStageId
          WHERE ${whereSql}
          ORDER BY cf.cashFlowId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        `SELECT COUNT(*) AS total FROM cashFlow cf WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, entries: rows });
});

// GET /api/cash-flow/:id
router.get('/:id', async (req, res) => {
    const entry = await CashFlow.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Not found' });
    res.json(entry);
});

// POST /api/cash-flow  { projectId, cashFlowStageId, cashFlowNote?, costPercentage?, orderNumber? }
router.post('/', async (req, res) => {
    if (!req.body.projectId) {
        return res.status(400).json({ message: 'projectId is required' });
    }
    try {
        const entry = await CashFlow.create(whitelist(CashFlow, req.body, ['cashFlowId']));
        res.status(201).json(entry);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A cash flow entry with that value already exists' });
        }
        console.error('Error creating cash flow entry:', err);
        res.status(500).json({ message: 'Failed to create cash flow entry' });
    }
});

// PATCH /api/cash-flow/:id
router.patch('/:id', async (req, res) => {
    const entry = await CashFlow.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Not found' });
    try {
        await entry.update(whitelist(CashFlow, req.body, ['cashFlowId']));
        res.json(entry);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A cash flow entry with that value already exists' });
        }
        console.error('Error updating cash flow entry:', err);
        res.status(500).json({ message: 'Failed to update cash flow entry' });
    }
});

/* ---------------- Payments (cashFlowDetails) ---------------- */

// GET /api/cash-flow/:id/payments
router.get('/:id/payments', async (req, res) => {
    const payments = await sequelize2PetraErp.query(
        `SELECT d.*, p.paymentTypeName, b.bankName
           FROM cashFlowDetails d
           LEFT JOIN paymentType p ON d.paymentTypeId = p.paymentTypeId
           LEFT JOIN bank b ON d.bankId = b.bankId
          WHERE d.cashFlowId = :cashFlowId
          ORDER BY d.cashFlowDetailsId DESC`,
        { replacements: { cashFlowId: req.params.id }, type: QueryTypes.SELECT },
    );
    res.json({ payments });
});

// POST /api/cash-flow/:id/payments  { paymentValue, paymentTypeId?, paymentDate?, expectedPaymentDate?, paid?, bankId?, docId? }
router.post('/:id/payments', async (req, res) => {
    if (req.body.paymentValue === undefined || req.body.paymentValue === null) {
        return res.status(400).json({ message: 'paymentValue is required' });
    }
    if (typeof req.body.paymentValue !== 'number' || req.body.paymentValue < 0) {
        return res.status(400).json({ message: 'paymentValue must be a non-negative number' });
    }
    try {
        const values = whitelist(CashFlowDetails, req.body, ['cashFlowDetailsId', 'cashFlowId']);
        const detail = await CashFlowDetails.create({ ...values, cashFlowId: req.params.id });
        res.status(201).json(detail);
    } catch (err) {
        console.error('Error creating payment:', err);
        res.status(500).json({ message: 'Failed to create payment' });
    }
});

// PATCH /api/cash-flow/:id/payments/:detailId
router.patch('/:id/payments/:detailId', async (req, res) => {
    const detail = await CashFlowDetails.findOne({
        where: { cashFlowDetailsId: req.params.detailId, cashFlowId: req.params.id },
    });
    if (!detail) return res.status(404).json({ message: 'Not found' });
    if (req.body.paymentValue !== undefined) {
        if (req.body.paymentValue === null || typeof req.body.paymentValue !== 'number' || req.body.paymentValue < 0) {
            return res.status(400).json({ message: 'paymentValue must be a non-negative number' });
        }
    }
    try {
        await detail.update(whitelist(CashFlowDetails, req.body, ['cashFlowDetailsId', 'cashFlowId']));
        res.json(detail);
    } catch (err) {
        console.error('Error updating payment:', err);
        res.status(500).json({ message: 'Failed to update payment' });
    }
});

// DELETE /api/cash-flow/:id/payments/:detailId
router.delete('/:id/payments/:detailId', async (req, res) => {
    try {
        const deleted = await CashFlowDetails.destroy({
            where: { cashFlowDetailsId: req.params.detailId, cashFlowId: req.params.id },
        });
        if (!deleted) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'deleted' });
    } catch (err) {
        console.error('Error deleting payment:', err);
        res.status(500).json({ message: 'Failed to delete payment' });
    }
});

export default router;
