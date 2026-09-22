// backend/routes/materialsWarehouseCosting.js
// WH.4: read/adjust the running valuation per item+store, per the Alpha
// Warehouse Analysis report §10. Both lastCost and weightedAvgCost are
// already maintained (services/matWhLedger.js's applyReceiptCost, called
// from every goods receipt) -- this file just exposes them and lets
// costMethod be switched, which is a flag flip here, not a recompute,
// since both figures are already kept current regardless of which is live.
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';

const router = express.Router();
const requireItemCost = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_ITEM_COST);
router.use(authenticateToken, requireItemCost);

router.get('/item-cost', async (req, res) => {
    const where = {};
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.storeId) where.storeId = req.query.storeId;
    const rows = await MatWhItemCost.findAll({ where, order: [['itemId', 'ASC']] });
    res.json({ items: rows });
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
