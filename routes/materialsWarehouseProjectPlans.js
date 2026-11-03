// backend/routes/materialsWarehouseProjectPlans.js
// Project material plans (2026-11-01) -- production's plan per order /
// phase of a project, its availability check (warn-only, nothing held),
// requesting lines as a production request, and the project status page.
// The logic lives in services/matWhProjectPlans.js.
//
// Who: production (.production_request) and store staff (.reserve) build
// and request plans; store managers and production managers can read them.
// A store-scoped caller only sees and adds lines of their own stores.
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { getAllowedStoreIds } from '../services/matWhStoreAccess.js';
import { needsProductionApproval } from './materialsWarehouseOperations.js';
import {
    createPlan, updatePlan, addPlanLines, updatePlanLine, deletePlanLine,
    checkPlan, requestPlanLines, planDetail, listPlans, projectStatus,
} from '../services/matWhProjectPlans.js';

const router = express.Router();
router.use(authenticateToken);

function requireAnyOf(...keys) {
    return async (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (req.user.role === 'admin') return next();
        try {
            const granted = await getPermissionsForRole(req.user.role);
            if (keys.some((k) => granted.includes(k))) return next();
            res.status(403).json({ success: false, message: 'Forbidden' });
        } catch (err) {
            console.error('Permission check failed:', err);
            res.status(500).json({ success: false, message: 'Permission check failed' });
        }
    };
}

const requirePlanWrite = requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_PRODUCTION_REQUEST,
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
);
const requirePlanRead = requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_PRODUCTION_REQUEST,
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER,
    PERMISSIONS.MATERIALS_WAREHOUSE_PRODUCTION_APPROVE,
);

// Runs a service call and maps its status-carrying errors to a response.
const handle = (fn) => async (req, res) => {
    try {
        res.json(await fn(req, res));
    } catch (err) {
        if (!err.status) console.error('Project plan error:', err);
        res.status(err.status || 500).json({ message: err.message || 'Project plan request failed' });
    }
};

router.get('/project-plans', requirePlanRead, handle(async (req) => ({
    items: await listPlans({
        projectId: req.query.projectId ? Number(req.query.projectId) : null,
        status: req.query.status || null,
        q: String(req.query.q || '').trim() || null,
    }, await getAllowedStoreIds(req.user)),
})));

router.post('/project-plans', requirePlanWrite, async (req, res) => {
    try {
        const plan = await createPlan(req.body, req.user.userId);
        res.status(201).json(plan);
    } catch (err) {
        if (!err.status) console.error('Error creating project plan:', err);
        res.status(err.status || 500).json({ message: err.message || 'Failed to create plan' });
    }
});

router.get('/project-plans/project/:projectId', requirePlanRead, handle(async (req) =>
    projectStatus(Number(req.params.projectId), await getAllowedStoreIds(req.user))));

router.get('/project-plans/:id', requirePlanRead, handle(async (req) =>
    planDetail(Number(req.params.id), await getAllowedStoreIds(req.user))));

router.patch('/project-plans/:id', requirePlanWrite, handle(async (req) =>
    updatePlan(Number(req.params.id), req.body)));

router.post('/project-plans/:id/lines', requirePlanWrite, handle(async (req) =>
    addPlanLines(Number(req.params.id), req.body.lines, await getAllowedStoreIds(req.user))));

router.patch('/project-plans/:id/lines/:lineId', requirePlanWrite, handle(async (req) =>
    updatePlanLine(Number(req.params.id), Number(req.params.lineId), req.body, await getAllowedStoreIds(req.user))));

router.delete('/project-plans/:id/lines/:lineId', requirePlanWrite, handle(async (req) => {
    await deletePlanLine(Number(req.params.id), Number(req.params.lineId));
    return { message: 'removed' };
}));

// Re-checkable any time; returns the refreshed plan.
router.post('/project-plans/:id/check', requirePlanWrite, handle(async (req) => {
    await checkPlan(Number(req.params.id));
    return planDetail(Number(req.params.id), await getAllowedStoreIds(req.user));
}));

// lineIds: the chosen lines, or omitted/null for every line not yet requested.
router.post('/project-plans/:id/request', requirePlanWrite, handle(async (req) => {
    const lineIds = Array.isArray(req.body.lineIds) && req.body.lineIds.length ? req.body.lineIds : null;
    return requestPlanLines(
        Number(req.params.id), lineIds, req.user,
        await needsProductionApproval(req.user), await getAllowedStoreIds(req.user),
    );
}));

export default router;
