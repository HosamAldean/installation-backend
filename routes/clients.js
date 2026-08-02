// backend/routes/clients.js
// Petra ERP — Clients module (Clients + Client References + Architect
// Offices). See Migration Blueprint §07 "Clients".
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { Client } from '../models/Client.js';
import { ClientReference } from '../models/ClientReference.js';
import { ArchOffice } from '../models/ArchOffice.js';

const router = express.Router();
router.use(authenticateToken);

// Also reused below by archOfficesRouter -- Arch Offices has no separate
// frontend page/nav item of its own (it's a lookup used within
// Clients/Offers forms), so it shares the Clients permission key rather
// than getting a 12th key of its own.
const canAccess = requirePermission(PERMISSIONS.PETRA_ERP_CLIENTS);

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

/* ---------------- Clients ---------------- */

// GET /api/clients?page=&pageSize=&q=
router.get('/', canAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const q = String(req.query.q || '').trim();
    const where = q ? { clientName: { [Op.like]: `%${q}%` } } : undefined;

    const { count, rows } = await Client.findAndCountAll({
        where,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        order: [['clientName', 'ASC']],
    });
    res.json({ total: count, clients: rows });
});

// GET /api/clients/:id
router.get('/:id', canAccess, async (req, res) => {
    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ message: 'Not found' });
    res.json(client);
});

// POST /api/clients
router.post('/', canAccess, async (req, res) => {
    if (!req.body.clientName || !String(req.body.clientName).trim()) {
        return res.status(400).json({ message: 'clientName is required' });
    }
    const client = await Client.create(whitelist(Client, req.body, ['clientId']));
    res.status(201).json(client);
});

// PATCH /api/clients/:id
router.patch('/:id', canAccess, async (req, res) => {
    const client = await Client.findByPk(req.params.id);
    if (!client) return res.status(404).json({ message: 'Not found' });
    await client.update(whitelist(Client, req.body, ['clientId']));
    res.json(client);
});

/* ---------------- Client References ---------------- */

// GET /api/clients/:id/references
router.get('/:id/references', canAccess, async (req, res) => {
    const references = await ClientReference.findAll({ where: { clientId: req.params.id } });
    res.json({ references });
});

// POST /api/clients/:id/references
router.post('/:id/references', canAccess, async (req, res) => {
    if (!req.body.clientReferenceName || !String(req.body.clientReferenceName).trim()) {
        return res.status(400).json({ message: 'clientReferenceName is required' });
    }
    const values = whitelist(ClientReference, req.body, ['clientReferenceId', 'clientId']);
    const reference = await ClientReference.create({ ...values, clientId: req.params.id });
    res.status(201).json(reference);
});

// PATCH /api/clients/:id/references/:refId
router.patch('/:id/references/:refId', canAccess, async (req, res) => {
    const reference = await ClientReference.findOne({
        where: { clientReferenceId: req.params.refId, clientId: req.params.id },
    });
    if (!reference) return res.status(404).json({ message: 'Not found' });
    await reference.update(whitelist(ClientReference, req.body, ['clientReferenceId', 'clientId']));
    res.json(reference);
});

// DELETE /api/clients/:id/references/:refId
router.delete('/:id/references/:refId', canAccess, async (req, res) => {
    const deleted = await ClientReference.destroy({
        where: { clientReferenceId: req.params.refId, clientId: req.params.id },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'deleted' });
});

export default router;

/* ---------------- Architect Offices ---------------- */
// Exported separately and mounted at /api/arch-offices in index.js — a
// distinct top-level resource per Migration Blueprint §07, just grouped
// into this file since archOffice is small and lives alongside Clients.
export const archOfficesRouter = express.Router();
archOfficesRouter.use(authenticateToken);

archOfficesRouter.get('/', canAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const q = String(req.query.q || '').trim();
    const where = q ? { archOfficeName: { [Op.like]: `%${q}%` } } : undefined;

    const { count, rows } = await ArchOffice.findAndCountAll({
        where,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        order: [['archOfficeName', 'ASC']],
    });
    res.json({ total: count, archOffices: rows });
});

archOfficesRouter.get('/:id', canAccess, async (req, res) => {
    const office = await ArchOffice.findByPk(req.params.id);
    if (!office) return res.status(404).json({ message: 'Not found' });
    res.json(office);
});

archOfficesRouter.post('/', canAccess, async (req, res) => {
    if (!req.body.archOfficeName || !String(req.body.archOfficeName).trim()) {
        return res.status(400).json({ message: 'archOfficeName is required' });
    }
    const office = await ArchOffice.create(whitelist(ArchOffice, req.body, ['archOfficeId']));
    res.status(201).json(office);
});

archOfficesRouter.patch('/:id', canAccess, async (req, res) => {
    const office = await ArchOffice.findByPk(req.params.id);
    if (!office) return res.status(404).json({ message: 'Not found' });
    await office.update(whitelist(ArchOffice, req.body, ['archOfficeId']));
    res.json(office);
});
