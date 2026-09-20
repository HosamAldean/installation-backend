// backend/routes/materialsWarehouseReporting.js
// WH.5: Reporting, computed against matWhStockLedger/matWhItemCost -- no
// new tables, per the Alpha Warehouse Analysis report §10. Card/Remaining
// Stock/In-Out mirror Stock House's own report tabs (§07); Purchase
// Pipeline is the Alpha-side equivalent. Overdue-invoices already exists
// in materialsWarehouseOperations.js (WH.2/§10's 7-day rule) -- not
// duplicated here.
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';
import { MatWhPurchaseOrder } from '../models/MatWhPurchaseOrder.js';
import { getAvailableToReserve } from '../services/matWhLedger.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS));

// ------------------------------------------------------------
// Card -- one item+store: current position plus recent activity.
// ------------------------------------------------------------
router.get('/reports/card', async (req, res) => {
    const itemId = parseInt(req.query.itemId);
    const storeId = parseInt(req.query.storeId);
    if (!itemId || !storeId) return res.status(400).json({ message: 'itemId and storeId are required' });

    const item = await MatWhItem.findByPk(itemId);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    const availableToReserve = await getAvailableToReserve(storeId, itemId);
    const costRow = await MatWhItemCost.findOne({ where: { itemId, storeId } });
    const recentMovements = await MatWhStockLedger.findAll({
        where: { itemId, storeId }, order: [['movementDate', 'DESC']], limit: 25,
    });

    res.json({
        item: { id: item.id, itemCode: item.itemCode, itemName: item.itemName, baseUnit: item.baseUnit },
        storeId,
        availableToReserve,
        currentCost: costRow?.currentCost ?? null,
        costMethod: costRow?.costMethod ?? 'lastCost',
        belowReorderPoint: item.reorderQty != null && availableToReserve < item.reorderQty,
        recentMovements,
    });
});

// ------------------------------------------------------------
// Remaining Stock -- balance across items, optionally scoped to one
// store. Single grouped query against the ledger rather than one query
// per item -- matWhItems can be large (Alpha's own equivalent has 26k
// rows, §04).
// ------------------------------------------------------------
router.get('/reports/remaining-stock', async (req, res) => {
    const storeId = req.query.storeId ? parseInt(req.query.storeId) : null;
    const belowReorderOnly = req.query.belowReorderOnly === 'true';

    const [balances] = await sequelizeUtf8.query(`
        SELECT itemId, storeId,
               SUM(CASE WHEN direction = 'in' THEN qty ELSE -qty END) AS balance
        FROM matWhStockLedger
        ${storeId ? 'WHERE storeId = :storeId' : ''}
        GROUP BY itemId, storeId
        HAVING balance != 0
    `, { replacements: storeId ? { storeId } : {} });

    const itemIds = [...new Set(balances.map((b) => b.itemId))];
    const items = await MatWhItem.findAll({ where: { id: itemIds } });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const costRows = await MatWhItemCost.findAll({ where: { itemId: itemIds } });
    const costByKey = new Map(costRows.map((c) => [`${c.itemId}:${c.storeId}`, c]));

    let rows = balances.map((b) => {
        const item = itemById.get(b.itemId);
        const cost = costByKey.get(`${b.itemId}:${b.storeId}`);
        return {
            itemId: b.itemId, storeId: b.storeId,
            itemCode: item?.itemCode, itemName: item?.itemName,
            balance: Number(b.balance),
            currentCost: cost?.currentCost ?? null,
            reorderQty: item?.reorderQty ?? null,
            belowReorderPoint: item?.reorderQty != null && Number(b.balance) < item.reorderQty,
        };
    });

    if (belowReorderOnly) rows = rows.filter((r) => r.belowReorderPoint);
    res.json({ items: rows });
});

// ------------------------------------------------------------
// In/Out -- ledger activity over a date range.
// ------------------------------------------------------------
router.get('/reports/in-out', async (req, res) => {
    const where = {};
    if (req.query.storeId) where.storeId = req.query.storeId;
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.docType) where.docType = req.query.docType;
    if (req.query.dateFrom || req.query.dateTo) {
        where.movementDate = {};
        if (req.query.dateFrom) where.movementDate[Op.gte] = new Date(req.query.dateFrom);
        if (req.query.dateTo) where.movementDate[Op.lte] = new Date(req.query.dateTo);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 100));
    const { count, rows } = await MatWhStockLedger.findAndCountAll({
        where, limit: pageSize, offset: (page - 1) * pageSize, order: [['movementDate', 'DESC'], ['id', 'DESC']],
    });

    const totalIn = rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.qty, 0);
    const totalOut = rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.qty, 0);
    res.json({ total: count, items: rows, pageTotals: { in: totalIn, out: totalOut } });
});

// ------------------------------------------------------------
// Purchase Pipeline -- Alpha-side equivalent: POs by status.
// ------------------------------------------------------------
router.get('/reports/purchase-pipeline', async (req, res) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT status, COUNT(*) AS count, SUM(netAmt) AS totalAmt
        FROM matWhPurchaseOrders
        GROUP BY status
    `);
    res.json({ statuses: rows });
});

export default router;
