// backend/routes/materialsWarehouseWriteoff.js
// Material Write-off: WM 10-41 (request, draft -> submitted ->
// approved/rejected) + WM 10-42 (report, filed once approved -- the real
// stock-movement event -- then committee-signed -> acknowledged). See
// services/matWhWriteoff.js for the full status/ledger design.
//
// .writeoff covers everything a storekeeper does (build/submit a request,
// file the destruction report, committee sign-off); .writeoff_approve is
// the distinct, higher-trust action (approve/reject the request, and the
// report's upper-management acknowledgment) -- same split rationale as
// .reserve/.issue elsewhere in this module.
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhWriteoffRequest } from '../models/MatWhWriteoffRequest.js';
import { MatWhWriteoffRequestItem } from '../models/MatWhWriteoffRequestItem.js';
import { MatWhWriteoffReport } from '../models/MatWhWriteoffReport.js';
import { MatWhWriteoffReportItem } from '../models/MatWhWriteoffReportItem.js';
import {
    createWriteoffRequest, submitWriteoffRequest, decideWriteoffRequest,
    createWriteoffReport, signWriteoffReportCommittee, acknowledgeWriteoffReport,
} from '../services/matWhWriteoff.js';

const router = express.Router();
router.use(authenticateToken);

const requireWriteoff = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF);
const requireWriteoffApprove = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF_APPROVE);

// Read access is shared -- an approver needs to see the same request list/
// detail a storekeeper does, just without the .writeoff actions.
// requirePermission responds directly on failure rather than calling
// next(err), so it can't be composed as an "either" check the way
// requireReserve/requireIssue are OR'd in materialsWarehouseOperations.js's
// requireAnyOf -- this does the same role-list check directly instead.
function requireAnyWriteoffAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    getPermissionsForRole(req.user.role).then((granted) => {
        if (granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF_APPROVE)) {
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }).catch((err) => {
        console.error('Permission check failed:', err);
        res.status(500).json({ success: false, message: 'Permission check failed' });
    });
}

// ============================================================
// Write-off Requests (WM 10-41)
// ============================================================

router.get('/writeoff-requests', requireAnyWriteoffAccess, async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    const rows = await MatWhWriteoffRequest.findAll({ where, order: [['id', 'DESC']] });
    res.json({ items: rows });
});

router.get('/writeoff-requests/:id', requireAnyWriteoffAccess, async (req, res) => {
    const request = await MatWhWriteoffRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ message: 'Not found' });
    const items = await MatWhWriteoffRequestItem.findAll({
        where: { writeoffRequestId: request.id }, order: [['id', 'ASC']],
    });
    const report = await MatWhWriteoffReport.findOne({ where: { writeoffRequestId: request.id } });
    let reportItems = [];
    if (report) {
        reportItems = await MatWhWriteoffReportItem.findAll({
            where: { writeoffReportId: report.id }, order: [['id', 'ASC']],
        });
    }
    res.json({ ...request.toJSON(), items, report: report ? { ...report.toJSON(), items: reportItems } : null });
});

router.post('/writeoff-requests', requireWriteoff, async (req, res) => {
    const { requestNo, storeId, projectId, projectNo, projectName, reason } = req.body;
    if (!requestNo || !String(requestNo).trim()) {
        return res.status(400).json({ message: 'requestNo is required' });
    }
    if (!storeId) return res.status(400).json({ message: 'storeId is required' });
    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ message: 'reason is required' });
    }
    try {
        const request = await createWriteoffRequest({
            requestNo: String(requestNo).trim(), storeId,
            projectId, projectNo, projectName, reason: String(reason).trim(),
            requestedBy: req.user.userId,
        });
        res.status(201).json(request);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A request with that number already exists' });
        }
        console.error('Error creating write-off request:', err);
        res.status(500).json({ message: 'Failed to create write-off request' });
    }
});

router.post('/writeoff-requests/:id/items', requireWriteoff, async (req, res) => {
    const request = await MatWhWriteoffRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ message: 'Write-off request not found' });
    if (request.status !== 'draft') {
        return res.status(409).json({ message: `Cannot add items to a request in status '${request.status}'` });
    }
    const { itemId, qtyRequested, reason } = req.body;
    if (!itemId || !qtyRequested) {
        return res.status(400).json({ message: 'itemId and qtyRequested are required' });
    }
    const line = await MatWhWriteoffRequestItem.create({
        writeoffRequestId: request.id, itemId, qtyRequested, reason: reason || null,
    });
    res.status(201).json(line);
});

router.delete('/writeoff-requests/:id/items/:lineId', requireWriteoff, async (req, res) => {
    const request = await MatWhWriteoffRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ message: 'Write-off request not found' });
    if (request.status !== 'draft') {
        return res.status(409).json({ message: `Cannot remove items from a request in status '${request.status}'` });
    }
    const line = await MatWhWriteoffRequestItem.findOne({
        where: { id: req.params.lineId, writeoffRequestId: request.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    await line.destroy();
    res.json({ message: 'removed' });
});

router.post('/writeoff-requests/:id/submit', requireWriteoff, async (req, res) => {
    try {
        const request = await submitWriteoffRequest(Number(req.params.id));
        res.json(request);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to submit request' });
    }
});

router.post('/writeoff-requests/:id/decide', requireWriteoffApprove, async (req, res) => {
    try {
        const request = await decideWriteoffRequest(
            Number(req.params.id), req.body?.decision, req.user.userId, req.body?.notes,
        );
        res.json(request);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to decide request' });
    }
});

// ============================================================
// Write-off Reports (WM 10-42)
// ============================================================

router.post('/writeoff-reports', requireWriteoff, async (req, res) => {
    const { writeoffRequestId, reportNo, destroyedDate, items } = req.body;
    if (!writeoffRequestId) return res.status(400).json({ message: 'writeoffRequestId is required' });
    if (!reportNo || !String(reportNo).trim()) {
        return res.status(400).json({ message: 'reportNo is required' });
    }
    if (!destroyedDate) return res.status(400).json({ message: 'destroyedDate is required' });
    try {
        const report = await createWriteoffReport({
            writeoffRequestId, reportNo: String(reportNo).trim(), destroyedDate,
            items, createdBy: req.user.userId,
        });
        res.status(201).json(report);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A report already exists for this request, or that report number is taken' });
        }
        res.status(err.status || 500).json({ message: err.message || 'Failed to file write-off report' });
    }
});

router.post('/writeoff-reports/:id/committee-sign', requireWriteoff, async (req, res) => {
    try {
        const report = await signWriteoffReportCommittee(Number(req.params.id), req.user.userId, req.body?.notes);
        res.json(report);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to sign report' });
    }
});

router.post('/writeoff-reports/:id/acknowledge', requireWriteoffApprove, async (req, res) => {
    try {
        const report = await acknowledgeWriteoffReport(Number(req.params.id), req.user.userId);
        res.json(report);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to acknowledge report' });
    }
});

export default router;
