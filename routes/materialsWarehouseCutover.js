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
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { postLedgerMovement, applyReceiptCost, getPhysicalBalance, normalizeColor, lockRow } from '../services/matWhLedger.js';
import { denyStore } from '../services/matWhStoreAccess.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_MASTER_DATA));

// Seeds starting physical stock for one item+store(+color+length) as of
// go-live. Guarded against re-seeding: once any real movement exists for
// that EXACT combination, this refuses -- opening balances are a one-time,
// before-go-live action, not a way to silently adjust stock later (that's
// what a write-off/adjustment movement type would be, not built in this
// pass). Scoped to color+length, not just item+store -- an ALM item's
// opening balance is entered once per real color+length combination it
// carries (mirrors how every other ledger query -- getPhysicalBalance,
// getAvailableToReserve -- already scopes to this same granularity).
// Checking item+store alone rejected a second color's/length's own
// first-ever entry just because an earlier, different color already
// posted one (caught live: item E8592, MILL/6300 entered fine, then
// 8022/6300 on the same item wrongly refused as "already has ledger
// activity").
router.post('/opening-balance', async (req, res) => {
    const { storeId, itemId, qty, unitCost, note, color, lengthMm } = req.body;
    if (!storeId || !itemId || qty === undefined) {
        return res.status(400).json({ message: 'storeId, itemId and qty are required' });
    }
    if (await denyStore(req, res, storeId)) return;

    const normalizedColor = normalizeColor(color || null);
    // Item row lock first (see lockRow), so a double submit can't pass the
    // "no activity yet" check twice and post two opening balances.
    const t = await sequelizeUtf8.transaction();
    let ledgerRow;
    try {
        if (!(await lockRow(MatWhItem, itemId, t))) {
            await t.rollback();
            return res.status(404).json({ message: 'Item not found' });
        }
        const existing = await MatWhStockLedger.count({
            where: { storeId, itemId, color: normalizedColor, lengthMm: lengthMm ?? null },
            transaction: t,
        });
        if (existing > 0) {
            await t.rollback();
            return res.status(409).json({
                message: 'This item/store/color/length already has ledger activity -- opening balance can only be entered before go-live for a given combination',
            });
        }

        ledgerRow = await postLedgerMovement({
            storeId, itemId, qty, direction: 'in', docType: 'opening_balance',
            refType: 'cutover', refId: null, unitCost, performedBy: req.user.userId,
            color: normalizedColor, lengthMm: lengthMm ?? null,
        }, t);

        if (unitCost != null) {
            await applyReceiptCost(itemId, storeId, qty, unitCost, t);
        }
        await t.commit();
    } catch (err) {
        await t.rollback();
        console.error('Opening balance failed:', err);
        return res.status(500).json({ message: 'Failed to post opening balance' });
    }

    res.status(201).json({
        ledgerEntryId: ledgerRow.id, storeId, itemId, qty, unitCost,
        color: color || null, lengthMm: lengthMm ?? null, note: note ?? null,
    });
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
