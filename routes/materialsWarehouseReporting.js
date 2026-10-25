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
// Shares the /api/materials-warehouse mount with the other warehouse
// routers: only guard /reports, let everything else through to the next
// router (same fix as routes/materialsWarehouse.js, 2026-10-22).
router.use((req, res, next) => (req.path.split('/')[1] === 'reports' ? next() : next('router')));
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
// rows, §04). With the real stock loaded (2026-10-18 cutover) an
// all-stores answer is ~5k rows, so ?page= (with optional ?search= on
// item code/name) returns one sorted page plus the total; without
// ?page= the full list comes back as before.
// ------------------------------------------------------------
router.get('/reports/remaining-stock', async (req, res) => {
    const storeId = req.query.storeId ? parseInt(req.query.storeId) : null;
    const belowReorderOnly = req.query.belowReorderOnly === 'true';
    const search = String(req.query.search || '').trim();
    const page = req.query.page ? Math.max(1, parseInt(req.query.page) || 1) : null;
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));

    const where = [];
    const replacements = {};
    if (storeId) { where.push('l.storeId = :storeId'); replacements.storeId = storeId; }
    if (search) {
        where.push('(i.itemCode LIKE :search OR i.itemName LIKE :search OR i.itemNameAr LIKE :search)');
        replacements.search = `%${search}%`;
    }
    const grouped = `
        SELECT l.itemId, l.storeId,
               SUM(CASE WHEN l.direction = 'in' THEN l.qty ELSE -l.qty END) AS balance
        FROM matWhStockLedger l
        JOIN matWhItems i ON i.id = l.itemId
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY l.itemId, l.storeId
        HAVING balance != 0
        ${belowReorderOnly ? 'AND MAX(i.reorderQty) IS NOT NULL AND balance < MAX(i.reorderQty)' : ''}
    `;

    let total = null;
    let balances;
    if (page) {
        const [[countRow]] = await sequelizeUtf8.query(`SELECT COUNT(*) AS n FROM (${grouped}) g`, { replacements });
        total = Number(countRow.n);
        [balances] = await sequelizeUtf8.query(`
            SELECT g.* FROM (${grouped}) g
            JOIN matWhItems i ON i.id = g.itemId
            ORDER BY i.itemCode, g.storeId
            LIMIT :limit OFFSET :offset
        `, { replacements: { ...replacements, limit: pageSize, offset: (page - 1) * pageSize } });
    } else {
        [balances] = await sequelizeUtf8.query(grouped, { replacements });
    }

    const itemIds = [...new Set(balances.map((b) => b.itemId))];
    const items = itemIds.length ? await MatWhItem.findAll({ where: { id: itemIds } }) : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    const costRows = itemIds.length ? await MatWhItemCost.findAll({ where: { itemId: itemIds } }) : [];
    const costByKey = new Map(costRows.map((c) => [`${c.itemId}:${c.storeId}`, c]));

    const rows = balances.map((b) => {
        const item = itemById.get(b.itemId);
        const cost = costByKey.get(`${b.itemId}:${b.storeId}`);
        return {
            itemId: b.itemId, storeId: b.storeId,
            itemCode: item?.itemCode, itemName: item?.itemName, itemNameAr: item?.itemNameAr ?? null,
            balance: Number(b.balance),
            currentCost: cost?.currentCost ?? null,
            reorderQty: item?.reorderQty ?? null,
            belowReorderPoint: item?.reorderQty != null && Number(b.balance) < item.reorderQty,
        };
    });

    if (page) return res.json({ items: rows, total, page, pageSize });
    res.json({ items: rows });
});

// ------------------------------------------------------------
// Stock Value (2026-10-25) -- what each store is worth: physical balance
// per item+store x that pair's currentCost (weighted average since
// 2026-10-22). One row per store plus a grand total; lines without a cost
// are counted, not guessed. With ?storeId=, also that store's items,
// highest value first, paged (?page=&pageSize=&search=).
// ------------------------------------------------------------
router.get('/reports/stock-value', async (req, res) => {
    const storeId = req.query.storeId ? parseInt(req.query.storeId) : null;
    const balances = (where = '') => `
        SELECT l.itemId, l.storeId,
               SUM(CASE WHEN l.direction = 'in' THEN l.qty ELSE -l.qty END) AS balance
        FROM matWhStockLedger l
        ${where}
        GROUP BY l.itemId, l.storeId
        HAVING ABS(balance) > 0.000001
    `;
    const [stores] = await sequelizeUtf8.query(`
        SELECT s.id AS storeId, s.storeCode, s.storeName, s.storeType,
               COUNT(b.itemId) AS \`lines\`,
               COALESCE(SUM(b.balance), 0) AS qty,
               COALESCE(SUM(b.balance * c.currentCost), 0) AS value,
               SUM(CASE WHEN b.itemId IS NOT NULL AND c.currentCost IS NULL THEN 1 ELSE 0 END) AS linesNoCost,
               SUM(CASE WHEN b.balance < 0 THEN 1 ELSE 0 END) AS negativeLines
        FROM matWhStores s
        LEFT JOIN (${balances()}) b ON b.storeId = s.id
        LEFT JOIN matWhItemCost c ON c.itemId = b.itemId AND c.storeId = b.storeId
        WHERE s.isActive = 1
        GROUP BY s.id, s.storeCode, s.storeName, s.storeType
        ORDER BY s.storeCode
    `);
    const num = (v) => Math.round(Number(v || 0) * 1000) / 1000;
    const storeRows = stores.map((s) => ({
        storeId: s.storeId, storeCode: s.storeCode, storeName: s.storeName, storeType: s.storeType,
        lines: Number(s.lines), qty: num(s.qty), value: num(s.value),
        linesNoCost: Number(s.linesNoCost || 0), negativeLines: Number(s.negativeLines || 0),
    }));
    const totals = storeRows.reduce((t, s) => ({
        lines: t.lines + s.lines, qty: num(t.qty + s.qty), value: num(t.value + s.value),
        linesNoCost: t.linesNoCost + s.linesNoCost, negativeLines: t.negativeLines + s.negativeLines,
    }), { lines: 0, qty: 0, value: 0, linesNoCost: 0, negativeLines: 0 });

    if (!storeId) return res.json({ stores: storeRows, totals });

    const search = String(req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
    const replacements = { storeId, limit: pageSize, offset: (page - 1) * pageSize };
    let searchSql = '';
    if (search) {
        searchSql = 'AND (i.itemCode LIKE :search OR i.itemName LIKE :search OR i.itemNameAr LIKE :search)';
        replacements.search = `%${search}%`;
    }
    const itemsSql = `
        FROM (${balances('WHERE l.storeId = :storeId')}) b
        JOIN matWhItems i ON i.id = b.itemId
        LEFT JOIN matWhItemCost c ON c.itemId = b.itemId AND c.storeId = b.storeId
        WHERE 1 = 1 ${searchSql}
    `;
    const [[countRow]] = await sequelizeUtf8.query(`SELECT COUNT(*) AS n ${itemsSql}`, { replacements });
    const [items] = await sequelizeUtf8.query(`
        SELECT b.itemId, i.itemCode, i.itemName, i.itemNameAr, i.baseUnit, b.balance,
               c.currentCost, b.balance * c.currentCost AS value
        ${itemsSql}
        ORDER BY (c.currentCost IS NULL), value DESC, i.itemCode
        LIMIT :limit OFFSET :offset
    `, { replacements });
    res.json({
        stores: storeRows, totals,
        items: items.map((r) => ({
            itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, itemNameAr: r.itemNameAr,
            baseUnit: r.baseUnit, balance: num(r.balance),
            currentCost: r.currentCost != null ? Number(r.currentCost) : null,
            value: r.value != null ? num(r.value) : null,
        })),
        total: Number(countRow.n), page, pageSize,
    });
});

// ------------------------------------------------------------
// In/Out -- ledger activity over a date range.
// ------------------------------------------------------------
router.get('/reports/in-out', async (req, res) => {
    const where = {};
    if (req.query.storeId) where.storeId = req.query.storeId;
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.docType) where.docType = req.query.docType;
    // Only ever populated on a reservation-line issue movement --
    // issueReservationLine (services/matWhReservations.js) is the one
    // postLedgerMovement caller that passes it. A goods receipt, external
    // processing, or opening-balance movement never carries a project, so
    // this narrows to issue activity for one project, not "everything that
    // ever touched this project."
    if (req.query.projectId) where.projectId = req.query.projectId;
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
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    const [rows] = await sequelizeUtf8.query(`
        SELECT status, COUNT(*) AS count, SUM(netAmt) AS totalAmt
        FROM matWhPurchaseOrders
        ${projectId ? 'WHERE projectId = :projectId' : ''}
        GROUP BY status
    `, { replacements: projectId ? { projectId } : {} });
    res.json({ statuses: rows });
});

export default router;
