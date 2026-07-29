// backend/routes/cr09Tags.js
// Petra ERP — CR09 feature views: motorUnitCR09, shutterBoxUnitCR09,
// shutterCoverUnitCR09, shutterUnitCR09. Show which contract units (rows
// in masterControl) carry a motor/shutter-box/shutter-cover/shutter
// feature. Per the Migration Blueprint §07 "Control Sheet".
//
// IMPORTANT: these are read-only SQL VIEWS, not tables (confirmed via
// SHOW CREATE TABLE -- TABLE_TYPE is VIEW). Each one is
// `masterControl JOIN productInfo JOIN profileSection`, filtered to a
// fixed profileSectionName ('Motor', 'Shutter Box', 'Shutter Cover',
// 'Shutter'). A unit is "tagged" simply by having its profileSectionId
// set to that profile section in Control Sheet -- there is no separate
// tag row to create/delete (confirmed empirically: MySQL rejects
// INSERT/DELETE against these with ER_NON_UPDATABLE_TABLE). So this
// module is GET-only; to change a unit's tag, edit its profileSectionId
// via routes/controlSheet.js instead. No legacy PHP code references these
// views at all (grepped the full app).
//
// Same read roles as Control Sheet/CR09: project_manager,
// installation_manager, admin.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { sequelize2PetraErp } from '../config/db.js';

const router = express.Router();
router.use(authenticateToken, authorizeRoles('project_manager', 'installation_manager', 'admin'));

const TAG_VIEWS = {
    motor: { view: 'motorUnitCR09', prefix: 'motor' },
    shutterBox: { view: 'shutterBoxUnitCR09', prefix: 'shutterBox' },
    shutterCover: { view: 'shutterCoverUnitCR09', prefix: 'shutterCover' },
    shutter: { view: 'shutterUnitCR09', prefix: 'shutter' },
};

router.param('tagType', (req, res, next, tagType) => {
    const cfg = TAG_VIEWS[tagType];
    if (!cfg) return res.status(404).json({ message: `Unknown tag type: ${tagType}` });
    req.tagCfg = cfg;
    next();
});

// GET /api/cr09/tags/:tagType?projectId=
router.get('/:tagType', async (req, res) => {
    if (!req.query.projectId) return res.status(400).json({ message: 'projectId is required' });
    const { view, prefix } = req.tagCfg;
    const rows = await sequelize2PetraErp.query(
        `SELECT * FROM \`${view}\` WHERE \`${prefix}ProjectId\` = :projectId ORDER BY \`${prefix}RowId\` ASC`,
        { replacements: { projectId: req.query.projectId }, type: QueryTypes.SELECT },
    );
    res.json({ tags: rows });
});

export default router;
