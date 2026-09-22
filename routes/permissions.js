// backend/routes/permissions.js
// Admin-only endpoints backing the permission grant-matrix page
// (frontend/src/pages/admin/Permissions.tsx). Lets an admin toggle which
// roles can access which pages/features without a code deploy -- see
// backend/middleware/permissions.js for how grants are enforced.
import express from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { PermissionGrant } from '../models/PermissionGrant.js';
import { PermissionGrantAudit } from '../models/PermissionGrantAudit.js';
import { invalidatePermissionsCache } from '../middleware/permissions.js';
import {
    PERMISSION_LIST,
    PERMISSION_GROUPS,
    ASSIGNABLE_ROLES,
} from '../constants/permissions.js';

const router = express.Router();
router.use(authenticateToken, authorizeRoles('admin'));

const VALID_KEYS = new Set(PERMISSION_LIST.map((p) => p.key));

// GET / -- everything the matrix UI needs in one round trip.
router.get('/', async (req, res) => {
    const grants = await PermissionGrant.findAll({
        attributes: ['role', 'permissionKey'],
    });
    res.json({
        groups: PERMISSION_GROUPS,
        keys: PERMISSION_LIST,
        roles: ASSIGNABLE_ROLES,
        grants: grants.map((g) => ({ role: g.role, permissionKey: g.permissionKey })),
    });
});

// PUT / -- single-cell toggle. Body: { role, permissionKey, granted }.
router.put('/', async (req, res) => {
    const { role, permissionKey, granted } = req.body;

    if (!ASSIGNABLE_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: 'Unknown role' });
    }
    if (!VALID_KEYS.has(permissionKey)) {
        return res.status(400).json({ success: false, message: 'Unknown permission key' });
    }

    try {
        if (granted) {
            const [, created] = await PermissionGrant.findOrCreate({
                where: { role, permissionKey },
                defaults: { grantedByUserId: req.user.userId },
            });
            // Only log an actual state change -- toggling "on" a permission
            // that's already granted is a no-op, not a real grant event.
            if (created) {
                await PermissionGrantAudit.create({ role, permissionKey, action: 'granted', performedByUserId: req.user.userId });
            }
        } else {
            const deletedCount = await PermissionGrant.destroy({ where: { role, permissionKey } });
            if (deletedCount > 0) {
                await PermissionGrantAudit.create({ role, permissionKey, action: 'revoked', performedByUserId: req.user.userId });
            }
        }

        invalidatePermissionsCache();

        const grants = await PermissionGrant.findAll({
            attributes: ['role', 'permissionKey'],
        });
        res.json({
            grants: grants.map((g) => ({ role: g.role, permissionKey: g.permissionKey })),
        });
    } catch (err) {
        console.error('Error updating permission grant:', err);
        res.status(500).json({ success: false, message: 'Failed to update permission grant' });
    }
});

export default router;
