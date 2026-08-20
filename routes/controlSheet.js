// backend/routes/controlSheet.js
// Petra ERP — Control Sheet module (PH.3, "highest effort" per Migration
// Blueprint §07). Covers masterControl (production-unit status tracking)
// only. Deliberately NOT built here, same reasoning as Offers' deferred
// pieces -- too much scope for one pass:
//   - CR09/CR09Detail -- project-level specification presets (color,
//     glass, shutter, security, ~24 mostly-lookup fields per project).
//     A real, separate sub-feature; PPC01/CR09Detail territory.
//   - The glass/shutter/spec columns already on masterControl itself
//     (glassOuterSpecs, shutterRail, colLenght, custAngle, ...) -- modeled
//     in ControlSheetUnit.js for completeness but not exposed here.
//   - editControlSheetPerc's per-department single-field update pattern
//     from the legacy app -- the general PATCH /:id below covers editing
//     any of the five percentage fields already, no need for a narrower
//     specialized endpoint.
//
// The percentage-clamp business rule below is reproduced exactly from
// legacy Controlsheet.php's addControlSheet()/editAllControlSheet(): if
// any of mResPerc/poPerc/proCompPerc/installCompPerc/finishDelPerc is
// submitted as >100, it gets reset to 0 -- not clamped to 100, reset
// entirely. Read directly from the legacy source before writing this,
// not inferred or guessed (see Migration Blueprint's sign-off-gate note
// for this exact module).
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelize2PetraErp } from '../config/db.js';
import { ControlSheetUnit } from '../models/ControlSheetUnit.js';

const router = express.Router();
router.use(authenticateToken);

const canAccess = requirePermission(PERMISSIONS.PETRA_ERP_CONTROL_SHEET);

const PERCENT_FIELDS = ['mResPerc', 'poPerc', 'proCompPerc', 'installCompPerc', 'finishDelPerc'];

// Mirrors Controlsheet.php's `if ($x > 100) { $x = 0; }` per field --
// not a clamp to 100, a full reset to 0.
function applyPercentClamp(values) {
    for (const f of PERCENT_FIELDS) {
        if (typeof values[f] === 'number' && values[f] > 100) values[f] = 0;
    }
    return values;
}

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

// GET /api/control-sheets?projectId=&orderId=&q=&page=&pageSize=&includeDeleted=
router.get('/', canAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

    const conditions = [req.query.includeDeleted ? '1=1' : '(m.deleted = 0 OR m.deleted IS NULL)'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.projectId) { conditions.push('m.projectId = :projectId'); replacements.projectId = req.query.projectId; }
    if (req.query.orderId) { conditions.push('m.orderId = :orderId'); replacements.orderId = req.query.orderId; }
    if (req.query.q) { conditions.push('(m.unitIdContract LIKE :q OR m.unitIdDetail LIKE :q)'); replacements.q = `%${req.query.q}%`; }
    const whereSql = conditions.join(' AND ');

    const units = await sequelize2PetraErp.query(
        `SELECT m.*, p.profileSectionName, s.unityStatusName, g.unityStageName
           FROM masterControl m
           LEFT JOIN profileSection p ON m.profileSectionId = p.profileSectionId
           LEFT JOIN unityStatus s ON m.unityStatusId = s.unityStatusId
           LEFT JOIN unityStage g ON m.unityStageId = g.unityStageId
          WHERE ${whereSql}
          ORDER BY m.rowId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2PetraErp.query(
        `SELECT COUNT(*) AS total FROM masterControl m WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, units });
});

// GET /api/control-sheets/:id
router.get('/:id', canAccess, async (req, res) => {
    const unit = await ControlSheetUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ message: 'Not found' });
    res.json(unit);
});

// POST /api/control-sheets  { projectId, unitIdContract?, unitIdDetail?, profileSectionId?, height?, width?, ... }
router.post('/', canAccess, async (req, res) => {
    if (!req.body.projectId) {
        return res.status(400).json({ message: 'projectId is required' });
    }
    try {
        const values = applyPercentClamp(whitelist(ControlSheetUnit, req.body, ['rowId']));
        const unit = await ControlSheetUnit.create(values);
        res.status(201).json(unit);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A unit with that value already exists' });
        }
        console.error('Error creating control sheet unit:', err);
        res.status(500).json({ message: 'Failed to create unit' });
    }
});

// PATCH /api/control-sheets/:id
router.patch('/:id', canAccess, async (req, res) => {
    const unit = await ControlSheetUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ message: 'Not found' });
    try {
        const values = applyPercentClamp(whitelist(ControlSheetUnit, req.body, ['rowId']));
        await unit.update(values);
        res.json(unit);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A unit with that value already exists' });
        }
        console.error('Error updating control sheet unit:', err);
        res.status(500).json({ message: 'Failed to update unit' });
    }
});

// DELETE /api/control-sheets/:id -- soft delete, matches the existing
// `deleted` column already in use on live data (same convention as
// Order.js/petraErpOrders.js).
router.delete('/:id', canAccess, async (req, res) => {
    const unit = await ControlSheetUnit.findByPk(req.params.id);
    if (!unit) return res.status(404).json({ message: 'Not found' });
    try {
        await unit.update({ deleted: 1 });
        res.json({ message: 'deleted' });
    } catch (err) {
        console.error('Error deleting control sheet unit:', err);
        res.status(500).json({ message: 'Failed to delete unit' });
    }
});

export default router;
