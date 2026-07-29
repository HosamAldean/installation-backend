// backend/routes/offers.js
// Petra ERP — Offers module (PH.5). See Migration Blueprint §07 "Offers".
// offers.php in the legacy app is ~140 methods across 6+ sub-domains; this
// covers the core offer entity, notes/client links, quotations (pricing
// line items), the change-request workflow (offerChanges), and contract
// notes -- all nested here since they're always offer-scoped.
// Roles narrower than Projects/Clients, matching the blueprint's "Roles:
// sales, sales_manager, admin" for this module.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { sequelize2PetraErp } from '../config/db.js';
import { Offer } from '../models/Offer.js';
import { OfferNotes } from '../models/OfferNotes.js';
import { OfferClients } from '../models/OfferClients.js';
import { Quotation } from '../models/Quotation.js';
import { OfferChanges } from '../models/OfferChanges.js';
import { OfferContractNotes } from '../models/OfferContractNotes.js';

const router = express.Router();
router.use(authenticateToken, authorizeRoles('sales', 'sales_manager', 'admin'));

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

// GET /api/offers?page=&pageSize=&q=&clientId=&offerStatusId=
router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

    const conditions = ['1=1'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.q) { conditions.push('(o.offerName LIKE :q OR o.projectName LIKE :q)'); replacements.q = `%${req.query.q}%`; }
    if (req.query.clientId) { conditions.push('o.clientId = :clientId'); replacements.clientId = req.query.clientId; }
    if (req.query.offerStatusId) { conditions.push('o.offerStatusId = :offerStatusId'); replacements.offerStatusId = req.query.offerStatusId; }
    const whereSql = conditions.join(' AND ');

    const offers = await sequelize2PetraErp.query(
        `SELECT o.*, c.clientName, s.offerStatusName,
                u.firstName AS salesPersonFirstName, u.lastName AS salesPersonLastName
           FROM offers o
           LEFT JOIN client c ON o.clientId = c.clientId
           LEFT JOIN offerStatus s ON o.offerStatusId = s.offerStatusId
           LEFT JOIN InsUser u ON o.salesPersonId = u.userId
          WHERE ${whereSql}
          ORDER BY o.offerId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        `SELECT COUNT(*) AS total FROM offers o WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, offers });
});

// GET /api/offers/:id
router.get('/:id', async (req, res) => {
    const offer = await Offer.findByPk(req.params.id);
    if (!offer) return res.status(404).json({ message: 'Not found' });
    res.json(offer);
});

// POST /api/offers  { offerName, projectName, clientId, offerStatusId, inquiryDate, startDate, endDate, expectedDate, signExDate, salesPersonId?, generalDesc? }
router.post('/', async (req, res) => {
    const required = ['offerName', 'projectName', 'clientId', 'offerStatusId', 'inquiryDate', 'startDate', 'endDate', 'expectedDate', 'signExDate'];
    for (const f of required) {
        if (req.body[f] === undefined || req.body[f] === '') {
            return res.status(400).json({ message: `${f} is required` });
        }
    }
    const [{ maxOfferNumber }] = await sequelize2PetraErp.query(
        'SELECT COALESCE(MAX(offerNumber), 0) AS maxOfferNumber FROM offers',
        { type: QueryTypes.SELECT },
    );
    const values = whitelist(Offer, req.body, ['offerId', 'offerNumber', 'lastUpdated']);
    const offer = await Offer.create({
        ...values,
        offerNumber: (maxOfferNumber || 0) + 1,
        sentToClientDate: req.body.sentToClientDate || req.body.startDate,
        lastUpdated: new Date(),
    });
    res.status(201).json(offer);
});

// PATCH /api/offers/:id
router.patch('/:id', async (req, res) => {
    const offer = await Offer.findByPk(req.params.id);
    if (!offer) return res.status(404).json({ message: 'Not found' });
    await offer.update({
        ...whitelist(Offer, req.body, ['offerId', 'offerNumber', 'lastUpdated']),
        lastUpdated: new Date(),
    });
    res.json(offer);
});

/* ---------------- Notes ---------------- */

// GET /api/offers/:id/notes
router.get('/:id/notes', async (req, res) => {
    const notes = await OfferNotes.findAll({
        where: { offerId: req.params.id },
        order: [['offerNotesDate', 'DESC']],
    });
    res.json({ notes });
});

// POST /api/offers/:id/notes  { offerNotesText }
router.post('/:id/notes', async (req, res) => {
    if (!req.body.offerNotesText?.trim()) {
        return res.status(400).json({ message: 'offerNotesText is required' });
    }
    const note = await OfferNotes.create({
        offerId: req.params.id,
        offerNotesText: req.body.offerNotesText,
        offerNotesDate: new Date(),
    });
    res.status(201).json(note);
});

/* ---------------- Client links ---------------- */

// GET /api/offers/:id/clients
router.get('/:id/clients', async (req, res) => {
    const links = await sequelize2PetraErp.query(
        `SELECT oc.*, c.clientName
           FROM offerClients oc
           LEFT JOIN client c ON oc.clientId = c.clientId
          WHERE oc.offerId = :offerId`,
        { replacements: { offerId: req.params.id }, type: QueryTypes.SELECT },
    );
    res.json({ clients: links });
});

// POST /api/offers/:id/clients  { clientId, offerClientsNote? }
router.post('/:id/clients', async (req, res) => {
    if (!req.body.clientId) return res.status(400).json({ message: 'clientId is required' });
    const link = await OfferClients.create({
        offerId: req.params.id,
        clientId: req.body.clientId,
        offerClientsNote: req.body.offerClientsNote || '',
    });
    res.status(201).json(link);
});

// DELETE /api/offers/:id/clients/:linkId
router.delete('/:id/clients/:linkId', async (req, res) => {
    const deleted = await OfferClients.destroy({
        where: { offerClientsId: req.params.linkId, offerId: req.params.id },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'deleted' });
});

/* ---------------- Quotations (pricing line items) ---------------- */

// GET /api/offers/:id/quotations?qChoiceNo= -- omit qChoiceNo to see all
// choices/revisions for the offer, grouped implicitly by the qChoiceNo
// column in the response.
router.get('/:id/quotations', async (req, res) => {
    const conditions = ['q.offerId = :offerId'];
    const replacements = { offerId: req.params.id };
    if (req.query.qChoiceNo !== undefined) {
        conditions.push('q.qChoiceNo = :qChoiceNo');
        replacements.qChoiceNo = req.query.qChoiceNo;
    }
    const quotations = await sequelize2PetraErp.query(
        `SELECT q.*, p.profileSectionName
           FROM quotations q
           LEFT JOIN profileSection p ON q.profileSectionId = p.profileSectionId
          WHERE ${conditions.join(' AND ')}
          ORDER BY q.qChoiceNo DESC, q.quotationId ASC`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ quotations });
});

// POST /api/offers/:id/quotations  { profileSectionId, value, price, measurmentId, qChoiceNo?, qDiscountPerc? }
router.post('/:id/quotations', async (req, res) => {
    const required = ['profileSectionId', 'value', 'price', 'measurmentId'];
    for (const f of required) {
        if (req.body[f] === undefined) return res.status(400).json({ message: `${f} is required` });
    }
    const values = whitelist(Quotation, req.body, ['quotationId', 'offerId']);
    const quotation = await Quotation.create({ ...values, offerId: req.params.id });
    res.status(201).json(quotation);
});

// PATCH /api/offers/:id/quotations/:quotationId
router.patch('/:id/quotations/:quotationId', async (req, res) => {
    const quotation = await Quotation.findOne({
        where: { quotationId: req.params.quotationId, offerId: req.params.id },
    });
    if (!quotation) return res.status(404).json({ message: 'Not found' });
    await quotation.update(whitelist(Quotation, req.body, ['quotationId', 'offerId']));
    res.json(quotation);
});

// DELETE /api/offers/:id/quotations/:quotationId
router.delete('/:id/quotations/:quotationId', async (req, res) => {
    const deleted = await Quotation.destroy({
        where: { quotationId: req.params.quotationId, offerId: req.params.id },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'deleted' });
});

/* ---------------- Changes (glass/coating change-request workflow) ---------------- */

// coatingTypeId is a fixed 4-value enum in the legacy app (Powder Coated,
// PVDF, Anodized, Wooden) -- there is no coatingType lookup table in the
// live schema (verified via SHOW TABLES). glassTypeId, despite its name,
// is a foreign key into glassSpecification (verified in
// templates/Admin/quotation.tpl), not a "glassType" table.
const COATING_TYPES = { 1: 'Powder Coated', 2: 'PVDF', 3: 'Anodized', 4: 'Wooden' };

// GET /api/offers/:id/changes
router.get('/:id/changes', async (req, res) => {
    const changes = await sequelize2PetraErp.query(
        `SELECT oc.*, g.glassSpecificationName
           FROM offerChanges oc
           LEFT JOIN glassSpecification g ON oc.glassTypeId = g.glassSpecificationId
          WHERE oc.offerId = :offerId
          ORDER BY oc.changeNo DESC, oc.offerChangesId DESC`,
        { replacements: { offerId: req.params.id }, type: QueryTypes.SELECT },
    );
    res.json({ changes: changes.map((c) => ({ ...c, coatingTypeName: COATING_TYPES[c.coatingTypeId] || null })) });
});

// POST /api/offers/:id/changes  { glassTypeId, coatingTypeId, offerChangesNote?, changeNo? }
router.post('/:id/changes', async (req, res) => {
    const required = ['glassTypeId', 'coatingTypeId'];
    for (const f of required) {
        if (req.body[f] === undefined) return res.status(400).json({ message: `${f} is required` });
    }
    const [{ maxChangeNo }] = await sequelize2PetraErp.query(
        'SELECT COALESCE(MAX(changeNo), 0) AS maxChangeNo FROM offerChanges WHERE offerId = :offerId',
        { replacements: { offerId: req.params.id }, type: QueryTypes.SELECT },
    );
    const values = whitelist(OfferChanges, req.body, ['offerChangesId', 'offerId', 'changeNo']);
    const change = await OfferChanges.create({
        ...values,
        offerId: req.params.id,
        changeNo: req.body.changeNo ?? (maxChangeNo || 0) + 1,
    });
    res.status(201).json(change);
});

// PATCH /api/offers/:id/changes/:changeId  -- also used to toggle offerApproved
router.patch('/:id/changes/:changeId', async (req, res) => {
    const change = await OfferChanges.findOne({
        where: { offerChangesId: req.params.changeId, offerId: req.params.id },
    });
    if (!change) return res.status(404).json({ message: 'Not found' });
    await change.update(whitelist(OfferChanges, req.body, ['offerChangesId', 'offerId']));
    res.json(change);
});

// DELETE /api/offers/:id/changes/:changeId
router.delete('/:id/changes/:changeId', async (req, res) => {
    const deleted = await OfferChanges.destroy({
        where: { offerChangesId: req.params.changeId, offerId: req.params.id },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'deleted' });
});

/* ---------------- Contract notes ---------------- */

// GET /api/offers/:id/contract-notes
router.get('/:id/contract-notes', async (req, res) => {
    const notes = await OfferContractNotes.findAll({
        where: { offerId: req.params.id },
        order: [['offerContractNotesDate', 'DESC']],
    });
    res.json({ notes });
});

// POST /api/offers/:id/contract-notes  { offerContractNotesType, offerContractNotesDesc }
router.post('/:id/contract-notes', async (req, res) => {
    const required = ['offerContractNotesType', 'offerContractNotesDesc'];
    for (const f of required) {
        if (!req.body[f]?.trim?.() && req.body[f] === undefined) {
            return res.status(400).json({ message: `${f} is required` });
        }
    }
    const note = await OfferContractNotes.create({
        offerId: req.params.id,
        offerContractNotesType: req.body.offerContractNotesType,
        offerContractNotesDesc: req.body.offerContractNotesDesc,
        offerContractNotesDate: new Date(),
    });
    res.status(201).json(note);
});

// PATCH /api/offers/:id/contract-notes/:noteId
router.patch('/:id/contract-notes/:noteId', async (req, res) => {
    const note = await OfferContractNotes.findOne({
        where: { offerContractNotesId: req.params.noteId, offerId: req.params.id },
    });
    if (!note) return res.status(404).json({ message: 'Not found' });
    await note.update(whitelist(OfferContractNotes, req.body, ['offerContractNotesId', 'offerId']));
    res.json(note);
});

// DELETE /api/offers/:id/contract-notes/:noteId
router.delete('/:id/contract-notes/:noteId', async (req, res) => {
    const deleted = await OfferContractNotes.destroy({
        where: { offerContractNotesId: req.params.noteId, offerId: req.params.id },
    });
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'deleted' });
});

export default router;
