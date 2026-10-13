// backend/routes/materialsWarehouseStockCount.js
// Stock Count (جرد) + variance adjustment. See services/matWhStockCount.js
// and the two MatWhStockCount* models for the full design.
//
// .stock_count covers the counters (create a sheet, count, add found
// items, submit, cancel); .stock_count_approve is the higher-trust review
// (sees system qty/variance/value, recount, approve -- which posts stock --
// or reject). Same split rationale as .writeoff / .writeoff_approve.
//
// Blind count: the system qty, variance and value are removed from every
// response here unless the caller is an approver -- enforced server-side,
// so a counter can't read them from the network tab either.
import express from 'express';
import { Op, QueryTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhStockCount } from '../models/MatWhStockCount.js';
import { MatWhStockCountLine } from '../models/MatWhStockCountLine.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import {
    createStockCount, countLine, addExtraLine, lookupBarcode, submitStockCount, cancelStockCount,
    recountLines, rejectStockCount, approveStockCount, reservationWarnings, currentCosts,
} from '../services/matWhStockCount.js';

const router = express.Router();
router.use(authenticateToken);

const requireCount = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_STOCK_COUNT);
const requireApprove = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_STOCK_COUNT_APPROVE);

async function isApprover(req) {
    if (req.user.role === 'admin') return true;
    const granted = await getPermissionsForRole(req.user.role);
    return granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_STOCK_COUNT_APPROVE);
}

// Reads are shared -- an approver needs the same list/detail a counter
// does (plus the hidden columns). Same direct role-list check as
// requireAnyWriteoffAccess, since requirePermission can't be OR'd.
function requireAnyStockCountAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    getPermissionsForRole(req.user.role).then((granted) => {
        if (granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_STOCK_COUNT) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_STOCK_COUNT_APPROVE)) {
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }).catch((err) => {
        console.error('Permission check failed:', err);
        res.status(500).json({ success: false, message: 'Permission check failed' });
    });
}

function sendError(res, err, fallback) {
    if (!err.status) console.error(fallback, err);
    res.status(err.status || 500).json({ message: err.status ? err.message : fallback });
}

// Counters only ever get what they need to count.
function lineForCounter(line) {
    const { systemQty, varianceQty, unitCost, ledgerEntryId, ...rest } = line;
    return rest;
}

async function storeNames(storeIds) {
    const stores = await MatWhStore.findAll({ where: { id: storeIds } });
    return new Map(stores.map((s) => [s.id, { storeCode: s.storeCode, storeName: s.storeName, storeNameAr: s.storeNameAr }]));
}

// Lookups for the "New count" dialog and the "add found item" search --
// kept here rather than reusing /store-lookup and /item-search, which are
// gated to reserve/issue/receive and so unreachable for a counter-only
// role. Declared before /stock-counts/:id so 'options' isn't read as an id.
router.get('/stock-counts/options', requireAnyStockCountAccess, async (req, res) => {
    const storeId = req.query.storeId ? Number(req.query.storeId) : null;
    const stores = await MatWhStore.findAll({ where: { isActive: true }, order: [['storeName', 'ASC']] });
    let categories = [];
    let zones = [];
    if (storeId) {
        const rows = await sequelizeUtf8.query(
            `SELECT DISTINCT i.category, s.zone
               FROM matWhItemStores s JOIN matWhItems i ON i.id = s.itemId
              WHERE s.storeId = :storeId AND i.isActive = 1`,
            { replacements: { storeId }, type: QueryTypes.SELECT },
        );
        categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
        zones = [...new Set(rows.map((r) => r.zone).filter(Boolean))].sort();
    }
    res.json({
        stores: stores.map((s) => ({ id: s.id, storeCode: s.storeCode, storeName: s.storeName, storeNameAr: s.storeNameAr })),
        categories, zones,
    });
});

router.get('/stock-counts/item-search', requireAnyStockCountAccess, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const items = await MatWhItem.findAll({
        where: {
            isActive: true,
            [Op.or]: [
                { itemCode: { [Op.like]: `%${q}%` } },
                { itemName: { [Op.like]: `%${q}%` } },
                { itemNameAr: { [Op.like]: `%${q}%` } },
            ],
        },
        limit: 20,
        order: [['itemCode', 'ASC']],
    });
    const variants = items.length
        ? await MatWhItemVariant.findAll({ where: { itemId: items.map((i) => i.id), isActive: true } })
        : [];
    res.json({
        items: items.map((i) => ({
            id: i.id, itemCode: i.itemCode, itemName: i.itemName, itemNameAr: i.itemNameAr, baseUnit: i.baseUnit,
            variants: variants.filter((v) => v.itemId === i.id)
                .map((v) => ({ color: v.color, lengthMm: v.lengthMm, barcode: v.barcode })),
        })),
    });
});

router.get('/stock-counts', requireAnyStockCountAccess, async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.storeId) where.storeId = Number(req.query.storeId);
    const counts = await MatWhStockCount.findAll({ where, order: [['id', 'DESC']], limit: 200 });
    const ids = counts.map((c) => c.id);
    const [stores, progress] = await Promise.all([
        storeNames([...new Set(counts.map((c) => c.storeId))]),
        ids.length
            ? MatWhStockCountLine.findAll({
                attributes: ['stockCountId', 'countedQty'],
                where: { stockCountId: ids },
                raw: true,
            })
            : [],
    ]);
    const totals = new Map();
    for (const p of progress) {
        const t = totals.get(p.stockCountId) || { lines: 0, counted: 0 };
        t.lines += 1;
        if (p.countedQty !== null) t.counted += 1;
        totals.set(p.stockCountId, t);
    }
    res.json({
        items: counts.map((c) => ({
            ...c.toJSON(), ...(stores.get(c.storeId) || {}),
            lineCount: totals.get(c.id)?.lines ?? 0, countedCount: totals.get(c.id)?.counted ?? 0,
        })),
    });
});

router.get('/stock-counts/:id', requireAnyStockCountAccess, async (req, res) => {
    const count = await MatWhStockCount.findByPk(req.params.id);
    if (!count) return res.status(404).json({ message: 'Not found' });
    const lines = await MatWhStockCountLine.findAll({
        where: { stockCountId: count.id },
        order: [['zone', 'ASC'], ['locationColumn', 'ASC'], ['locationRow', 'ASC'], ['id', 'ASC']],
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const [items, variants, stores, approver] = await Promise.all([
        itemIds.length ? MatWhItem.findAll({ where: { id: itemIds } }) : [],
        itemIds.length ? MatWhItemVariant.findAll({ where: { itemId: itemIds, isActive: true } }) : [],
        storeNames([count.storeId]),
        isApprover(req),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const barcodeFor = (line) => {
        const v = variants.find((x) => x.itemId === line.itemId
            && (x.color ?? null) === (line.color ?? null)
            && (x.lengthMm ?? null) === (line.lengthMm ?? null));
        return v?.barcode ?? itemById.get(line.itemId)?.barcode ?? null;
    };
    const costs = approver ? await currentCosts(count.storeId, itemIds) : new Map();

    const shaped = lines.map((l) => {
        const item = itemById.get(l.itemId);
        const base = {
            ...l.toJSON(),
            itemCode: item?.itemCode ?? null, itemName: item?.itemName ?? null,
            itemNameAr: item?.itemNameAr ?? null, baseUnit: item?.baseUnit ?? null,
            barcode: barcodeFor(l),
        };
        if (!approver) return lineForCounter(base);
        const currentCost = costs.get(l.itemId) ?? null;
        return {
            ...base, currentCost,
            varianceValue: l.varianceQty != null && currentCost != null ? l.varianceQty * currentCost : null,
        };
    });

    const warnings = approver && count.status === 'submitted' ? await reservationWarnings(count, lines) : [];
    res.json({ ...count.toJSON(), ...(stores.get(count.storeId) || {}), canApprove: approver, lines: shaped, warnings });
});

router.post('/stock-counts', requireCount, async (req, res) => {
    const { storeId, scopeCategory, scopeZone, notes } = req.body;
    if (!storeId) return res.status(400).json({ message: 'storeId is required' });
    try {
        const count = await createStockCount({
            storeId: Number(storeId), scopeCategory, scopeZone, notes, createdBy: req.user.userId,
        });
        res.status(201).json(count);
    } catch (err) {
        sendError(res, err, 'Failed to create stock count');
    }
});

router.get('/stock-counts/:id/lookup', requireAnyStockCountAccess, async (req, res) => {
    const code = String(req.query.barcode || '').trim();
    if (!code) return res.status(400).json({ message: 'barcode is required' });
    try {
        const result = await lookupBarcode(Number(req.params.id), code);
        const approver = await isApprover(req);
        res.json({ ...result, line: result.line && (approver ? result.line.toJSON() : lineForCounter(result.line.toJSON())) });
    } catch (err) {
        sendError(res, err, 'Lookup failed');
    }
});

router.put('/stock-counts/:id/lines/:lineId', requireCount, async (req, res) => {
    try {
        const line = await countLine(Number(req.params.id), Number(req.params.lineId), req.body?.countedQty, req.user.userId);
        res.json(lineForCounter(line.toJSON()));
    } catch (err) {
        sendError(res, err, 'Failed to save count');
    }
});

router.post('/stock-counts/:id/lines', requireCount, async (req, res) => {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });
    try {
        const line = await addExtraLine(Number(req.params.id), req.body, req.user.userId);
        res.status(201).json(lineForCounter(line.toJSON()));
    } catch (err) {
        sendError(res, err, 'Failed to add item');
    }
});

router.post('/stock-counts/:id/submit', requireCount, async (req, res) => {
    try {
        res.json(await submitStockCount(Number(req.params.id), req.user.userId));
    } catch (err) {
        sendError(res, err, 'Failed to submit count');
    }
});

router.post('/stock-counts/:id/cancel', requireAnyStockCountAccess, async (req, res) => {
    try {
        res.json(await cancelStockCount(Number(req.params.id)));
    } catch (err) {
        sendError(res, err, 'Failed to cancel count');
    }
});

router.post('/stock-counts/:id/recount', requireApprove, async (req, res) => {
    try {
        res.json(await recountLines(Number(req.params.id), req.body?.lineIds, req.user.userId, req.body?.notes));
    } catch (err) {
        sendError(res, err, 'Failed to send lines for recount');
    }
});

router.post('/stock-counts/:id/reject', requireApprove, async (req, res) => {
    try {
        res.json(await rejectStockCount(Number(req.params.id), req.user.userId, req.body?.notes));
    } catch (err) {
        sendError(res, err, 'Failed to reject count');
    }
});

router.post('/stock-counts/:id/approve', requireApprove, async (req, res) => {
    try {
        const { count, warnings } = await approveStockCount(Number(req.params.id), req.user.userId, {
            unitCosts: req.body?.unitCosts, notes: req.body?.notes,
        });
        res.json({ ...count.toJSON(), warnings });
    } catch (err) {
        sendError(res, err, 'Failed to approve count');
    }
});

export default router;
