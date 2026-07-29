// backend/routes/offers.js
// Petra ERP — Offers module (PH.5). See Migration Blueprint §07 "Offers".
// offers.php in the legacy app is ~140 methods across 6+ sub-domains; this
// covers the core offer entity plus its notes and client links only.
// Deliberately NOT built here (too much scope for one pass, needs its own
// follow-up):
//   - quotations (68k+ rows) -- the actual pricing line items per offer,
//     tied to profileSection/measurement and a real pricing calculation
//     this session didn't verify against the legacy app's business logic.
//   - offerChanges -- glass/coating change-request + approval workflow.
//   - offerContractNotes -- only 1 live row, negligible usage.
//   - leads, timeSheet -- separate small tables (25 and 919 rows) the
//     blueprint lists as their own pages (Leads.tsx, timesheets); not
//     touched this pass.
// Roles narrower than Projects/Clients, matching the blueprint's "Roles:
// sales, sales_manager, admin" for this module.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { sequelize2PetraErp } from '../config/db.js';
import { Offer } from '../models/Offer.js';
import { OfferNotes } from '../models/OfferNotes.js';
import { OfferClients } from '../models/OfferClients.js';

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

export default router;
