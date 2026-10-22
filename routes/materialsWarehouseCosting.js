// backend/routes/materialsWarehouseCosting.js
// WH.4: read/adjust the running valuation per item+store, per the Alpha
// Warehouse Analysis report §10. Both lastCost and weightedAvgCost are
// already maintained (services/matWhLedger.js's applyReceiptCost, called
// from every goods receipt) -- this file just exposes them and lets
// costMethod be switched, which is a flag flip here, not a recompute,
// since both figures are already kept current regardless of which is live.
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';
import { MatWhItem } from '../models/MatWhItem.js';

const router = express.Router();
const requireItemCost = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_ITEM_COST);
// Shares the /api/materials-warehouse mount with the other warehouse
// routers: only guard /item-cost, let everything else through to the next
// router (same fix as routes/materialsWarehouse.js, 2026-10-22).
router.use((req, res, next) => (req.path.split('/')[1] === 'item-cost' ? next() : next('router')));
router.use(authenticateToken, requireItemCost);

// Rows carry the item's code/name, so the page doesn't have to resolve
// thousands of ids itself (after the 2026-10-18 cutover there are ~4,800
// rows -- an items-by-ids URL for all of them is rejected with 431).
// Optional search (item code/name) and page/pageSize; without page every
// matching row comes back, as before.
router.get('/item-cost', async (req, res) => {
    const where = {};
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.storeId) where.storeId = req.query.storeId;
    const search = String(req.query.search || '').trim();
    if (search) {
        const matches = await MatWhItem.findAll({
            where: { [Op.or]: [
                { itemCode: { [Op.like]: `%${search}%` } },
                { itemName: { [Op.like]: `%${search}%` } },
                { itemNameAr: { [Op.like]: `%${search}%` } },
            ] },
            attributes: ['id'],
        });
        where.itemId = matches.map((m) => m.id);
    }
    const paged = req.query.page !== undefined;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 50));
    const { count, rows } = await MatWhItemCost.findAndCountAll({
        where,
        order: [['itemId', 'ASC'], ['storeId', 'ASC']],
        ...(paged ? { offset: (page - 1) * pageSize, limit: pageSize } : {}),
    });
    const items = await MatWhItem.findAll({
        where: { id: [...new Set(rows.map((r) => r.itemId))] },
        attributes: ['id', 'itemCode', 'itemName', 'itemNameAr'],
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    res.json({
        items: rows.map((r) => ({
            ...r.toJSON(),
            itemCode: itemById.get(r.itemId)?.itemCode ?? null,
            itemName: itemById.get(r.itemId)?.itemName ?? null,
            itemNameAr: itemById.get(r.itemId)?.itemNameAr ?? null,
        })),
        total: count,
        page,
        pageSize: paged ? pageSize : count,
    });
});

router.get('/item-cost/:itemId/:storeId', async (req, res) => {
    const row = await MatWhItemCost.findOne({ where: { itemId: req.params.itemId, storeId: req.params.storeId } });
    if (!row) return res.status(404).json({ message: 'No cost record for this item/store yet' });
    res.json(row);
});

// Switches which of the two already-maintained figures drives
// currentCost. Both lastCost and weightedAvgCost keep being updated on
// every future receipt regardless of which is selected.
router.patch('/item-cost/:id', async (req, res) => {
    const { costMethod } = req.body;
    if (!['lastCost', 'weightedAvg'].includes(costMethod)) {
        return res.status(400).json({ message: "costMethod must be 'lastCost' or 'weightedAvg'" });
    }
    const row = await MatWhItemCost.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });

    const currentCost = costMethod === 'weightedAvg' ? row.weightedAvgCost : row.lastCost;
    await row.update({ costMethod, currentCost });
    res.json(row);
});

export default router;
