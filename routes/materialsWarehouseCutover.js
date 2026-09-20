// backend/routes/materialsWarehouseCutover.js
// WH.6: Cutover, per the Alpha Warehouse Analysis report §10/§11. No
// history migrates from Stock House or Alpha (confirmed scope) -- day-one
// data comes from manual opening-balance entry instead. Open purchase
// orders from either legacy system carry forward the same way: re-created
// through the ordinary POST /purchase-orders endpoint, nothing special
// needed for that part. Gated by MATERIALS_WAREHOUSE_MASTER_DATA -- a
// one-time setup action, not routine storekeeper/accounting work.
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { postLedgerMovement, applyReceiptCost, getPhysicalBalance } from '../services/matWhLedger.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_MASTER_DATA));

// Seeds starting physical stock for one item+store as of go-live. Guarded
// against re-seeding: once any real movement exists for that item+store,
// this refuses -- opening balances are a one-time, before-go-live action,
// not a way to silently adjust stock later (that's what a write-off/
// adjustment movement type would be, not built in this pass).
router.post('/opening-balance', async (req, res) => {
    const { storeId, itemId, qty, unitCost, note } = req.body;
    if (!storeId || !itemId || qty === undefined) {
        return res.status(400).json({ message: 'storeId, itemId and qty are required' });
    }

    const existing = await MatWhStockLedger.count({ where: { storeId, itemId } });
    if (existing > 0) {
        return res.status(409).json({
            message: 'This item/store already has ledger activity -- opening balance can only be entered before go-live for a given item/store',
        });
    }

    const ledgerRow = await postLedgerMovement({
        storeId, itemId, qty, direction: 'in', docType: 'opening_balance',
        refType: 'cutover', refId: null, unitCost, performedBy: req.user.userId,
    });

    if (unitCost != null) {
        await applyReceiptCost(itemId, storeId, qty, unitCost);
    }

    res.status(201).json({ ledgerEntryId: ledgerRow.id, storeId, itemId, qty, unitCost, note: note ?? null });
});

// Spot-check during the WH.6 parallel run: compare a manually-counted or
// legacy-system figure against what the new system computes. Doesn't
// change anything -- read-only, for the person validating cutover.
router.post('/reconciliation-check', async (req, res) => {
    const { storeId, itemId, expectedQty } = req.body;
    if (!storeId || !itemId || expectedQty === undefined) {
        return res.status(400).json({ message: 'storeId, itemId and expectedQty are required' });
    }
    const systemQty = await getPhysicalBalance(storeId, itemId);
    const diff = systemQty - Number(expectedQty);
    res.json({ storeId, itemId, systemQty, expectedQty: Number(expectedQty), diff, matches: diff === 0 });
});

export default router;
