// backend/routes/petraErpOrders.js
// Petra ERP — production/manufacturing Orders module. See Migration
// Blueprint §07/§09: named petraErpOrders (not orders.js/projOrders.js —
// those already belong to the unrelated "Proj" SQL Server system in this
// repo — and not erp.js, already the config key for getSqlPool('erp')).
//
// An order is a batch of manufacturing work for one material department
// (orderTypeId), tracked through an approval -> factory -> manufactured
// -> installed pipeline (orderStatusId), with a GM sign-off step
// (gmNote/gmDate). `deleted` is a soft-delete flag on live data — never
// hard-delete.
//
// masterControl.orderId is the real link from a control-sheet unit to its
// order (88k/117k rows populated) — the separate `orderItems` join table
// exists but only has 31 rows total, confirmed dead/vestigial before
// building against it, so items here are read straight off masterControl.
import express from 'express';
import { QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelize2PetraErp as sequelize2 } from '../config/db.js';
import { Order } from '../models/Order.js';

const router = express.Router();
router.use(authenticateToken);

const canAccess = requirePermission(PERMISSIONS.PETRA_ERP_ORDERS);

function whitelist(model, body, excluding = []) {
    const attrs = Object.keys(model.getAttributes()).filter((a) => !excluding.includes(a));
    const values = {};
    for (const a of attrs) if (body[a] !== undefined) values[a] = body[a];
    return values;
}

// GET /api/petra-erp/orders?page=&pageSize=&q=&projectId=&orderTypeId=&orderStatusId=&includeDeleted=
// Raw join (rather than the plain Order model) so the list carries
// project/type/status names, not just ids — matches how list views are
// built elsewhere in this codebase (followUp.js, instOrders.js).
router.get('/', canAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

    const conditions = [req.query.includeDeleted ? '1=1' : 'o.deleted = 0'];
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    if (req.query.projectId) { conditions.push('o.projectId = :projectId'); replacements.projectId = req.query.projectId; }
    if (req.query.orderTypeId) { conditions.push('o.orderTypeId = :orderTypeId'); replacements.orderTypeId = req.query.orderTypeId; }
    if (req.query.orderStatusId) { conditions.push('o.orderStatusId = :orderStatusId'); replacements.orderStatusId = req.query.orderStatusId; }
    if (req.query.q) { conditions.push('o.orderNumber LIKE :q'); replacements.q = `%${req.query.q}%`; }
    const whereSql = conditions.join(' AND ');

    const orders = await sequelize2.query(
        `SELECT o.*, p.projectName, p.projectNo, t.orderTypeDesc, s.orderStatusName
           FROM orders o
           LEFT JOIN project p ON o.projectId = p.projectId
           LEFT JOIN orderType t ON o.orderTypeId = t.orderTypeId
           LEFT JOIN orderStatus s ON o.orderStatusId = s.orderStatusId
          WHERE ${whereSql}
          ORDER BY o.orderId DESC
          LIMIT :limit OFFSET :offset`,
        { replacements, type: QueryTypes.SELECT },
    );
    const [{ total }] = await sequelize2.query(
        `SELECT COUNT(*) AS total FROM orders o WHERE ${whereSql}`,
        { replacements, type: QueryTypes.SELECT },
    );
    res.json({ total, orders });
});

// GET /api/petra-erp/orders/:id
router.get('/:id', canAccess, async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
});

// POST /api/petra-erp/orders  { projectId, orderTypeId, orderDesc?, pmId? }
// orderNumber is sequential per project (matches the legacy app's
// getMaxOrderId() convention), not globally unique or client-supplied.
router.post('/', canAccess, async (req, res) => {
    const { projectId, orderTypeId } = req.body;
    if (!projectId || !orderTypeId) {
        return res.status(400).json({ message: 'projectId and orderTypeId are required' });
    }

    const [{ maxOrderNumber }] = await sequelize2.query(
        'SELECT COALESCE(MAX(orderNumber), 0) AS maxOrderNumber FROM orders WHERE projectId = :projectId',
        { replacements: { projectId }, type: QueryTypes.SELECT },
    );

    const values = whitelist(Order, req.body, ['orderId', 'orderNumber', 'userId', 'deleted', 'gmDate']);
    const order = await Order.create({
        ...values,
        projectId,
        orderTypeId,
        orderNumber: (maxOrderNumber || 0) + 1,
        userId: req.user.userId,
        pmId: req.body.pmId ?? req.user.userId,
        orderDate: req.body.orderDate ?? new Date(),
        orderStatusId: req.body.orderStatusId ?? 0,
        deleted: 0,
        gmDate: new Date(),
    });
    res.status(201).json(order);
});

// PATCH /api/petra-erp/orders/:id
router.patch('/:id', canAccess, async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ message: 'Not found' });
    await order.update(whitelist(Order, req.body, ['orderId', 'userId', 'deleted']));
    res.json(order);
});

// PATCH /api/petra-erp/orders/:id/status  { orderStatusId }
router.patch('/:id/status', canAccess, async (req, res) => {
    const { orderStatusId } = req.body;
    if (orderStatusId === undefined) {
        return res.status(400).json({ message: 'orderStatusId is required' });
    }
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ message: 'Not found' });
    await order.update({ orderStatusId });
    res.json(order);
});

// PATCH /api/petra-erp/orders/:id/gm-note  { gmNote }
router.patch('/:id/gm-note', canAccess, async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ message: 'Not found' });
    await order.update({ gmNote: req.body.gmNote ?? '', gmDate: new Date() });
    res.json(order);
});

// DELETE /api/petra-erp/orders/:id — soft delete, matches the `deleted`
// column already in use on live data.
router.delete('/:id', canAccess, async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ message: 'Not found' });
    await order.update({ deleted: 1 });
    res.json({ message: 'deleted' });
});

// GET /api/petra-erp/orders/:id/items — control-sheet units (masterControl
// rows) currently assigned to this order.
router.get('/:id/items', canAccess, async (req, res) => {
    const items = await sequelize2.query(
        `SELECT m.rowId, m.unitIdContract, m.unitIdDetail, m.height, m.width,
                m.unityStatusId, p.profileSectionName
           FROM masterControl m
           LEFT JOIN profileSection p ON m.profileSectionId = p.profileSectionId
          WHERE m.orderId = :orderId AND m.deleted = 0
          ORDER BY m.rowId`,
        { replacements: { orderId: req.params.id }, type: QueryTypes.SELECT },
    );
    res.json({ items });
});

// POST /api/petra-erp/orders/:id/items  { rowIds: number[] }
// Assigns existing control-sheet units to this order.
router.post('/:id/items', canAccess, async (req, res) => {
    const { rowIds } = req.body;
    if (!Array.isArray(rowIds) || rowIds.length === 0) {
        return res.status(400).json({ message: 'rowIds must be a non-empty array' });
    }
    await sequelize2.query(
        'UPDATE masterControl SET orderId = :orderId WHERE rowId IN (:rowIds)',
        { replacements: { orderId: req.params.id, rowIds }, type: QueryTypes.UPDATE },
    );
    res.json({ message: 'assigned' });
});

// DELETE /api/petra-erp/orders/:id/items/:rowId
router.delete('/:id/items/:rowId', canAccess, async (req, res) => {
    await sequelize2.query(
        'UPDATE masterControl SET orderId = 0 WHERE rowId = :rowId AND orderId = :orderId',
        { replacements: { rowId: req.params.rowId, orderId: req.params.id }, type: QueryTypes.UPDATE },
    );
    res.json({ message: 'unassigned' });
});

export default router;
