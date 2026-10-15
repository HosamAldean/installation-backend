// backend/routes/materialsWarehouseTransfer.js
// Store-to-store transfer. See services/matWhStoreTransfer.js and the two
// MatWhStoreTransfer* models for the full design. One permission,
// .transfer, covers both steps (send and receive).
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhStoreTransfer } from '../models/MatWhStoreTransfer.js';
import { MatWhStoreTransferLine } from '../models/MatWhStoreTransferLine.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { getAvailableToReserve } from '../services/matWhLedger.js';
import { denyStore } from '../services/matWhStoreAccess.js';
import {
    createTransfer, addLine, updateLine, removeLine, cancelTransfer, sendTransfer,
    receiveLines, lookupBarcode, loadTransfer,
} from '../services/matWhStoreTransfer.js';

const router = express.Router();
router.use(authenticateToken);

const requireTransfer = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_TRANSFER);

// Store scoping (see services/matWhStoreAccess.js): building, sending and
// cancelling a transfer is the source store's action; receiving it is the
// destination store's.
function requireTransferStore(side) {
    return async (req, res, next) => {
        const transfer = await MatWhStoreTransfer.findByPk(req.params.id);
        if (!transfer) return res.status(404).json({ message: 'Transfer not found' });
        if (await denyStore(req, res, side === 'to' ? transfer.toStoreId : transfer.fromStoreId)) return;
        next();
    };
}
const OPEN_STATUSES = ['sent', 'partially_received'];

function sendError(res, err, fallback) {
    if (!err.status) console.error(fallback, err);
    res.status(err.status || 500).json({ message: err.status ? err.message : fallback, details: err.details });
}

async function storeMap(storeIds) {
    const stores = storeIds.length ? await MatWhStore.findAll({ where: { id: storeIds } }) : [];
    return new Map(stores.map((s) => [s.id, { storeCode: s.storeCode, storeName: s.storeName, storeNameAr: s.storeNameAr }]));
}

function withStores(transfer, stores) {
    const from = stores.get(transfer.fromStoreId) || {};
    const to = stores.get(transfer.toStoreId) || {};
    return {
        ...transfer.toJSON(),
        fromStoreCode: from.storeCode ?? null, fromStoreName: from.storeName ?? null, fromStoreNameAr: from.storeNameAr ?? null,
        toStoreCode: to.storeCode ?? null, toStoreName: to.storeName ?? null, toStoreNameAr: to.storeNameAr ?? null,
    };
}

async function shapeLines(lines) {
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const [items, variants] = await Promise.all([
        itemIds.length ? MatWhItem.findAll({ where: { id: itemIds } }) : [],
        itemIds.length ? MatWhItemVariant.findAll({ where: { itemId: itemIds, isActive: true } }) : [],
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    return lines.map((l) => {
        const item = itemById.get(l.itemId);
        const variant = variants.find((v) => v.itemId === l.itemId
            && (v.color ?? null) === (l.color ?? null)
            && (v.lengthMm ?? null) === (l.lengthMm ?? null));
        return {
            ...(l.toJSON ? l.toJSON() : l),
            itemCode: item?.itemCode ?? null, itemName: item?.itemName ?? null,
            itemNameAr: item?.itemNameAr ?? null, baseUnit: item?.baseUnit ?? null,
            barcode: variant?.barcode ?? item?.barcode ?? null,
            hasVariants: variants.some((v) => v.itemId === l.itemId),
            qtyOutstanding: Math.max(0, l.qtySent - l.qtyReceived),
        };
    });
}

// Stores for the "New transfer" dialog. Declared before /:id.
router.get('/store-transfers/options', requireTransfer, async (req, res) => {
    const stores = await MatWhStore.findAll({ where: { isActive: true }, order: [['storeCode', 'ASC']] });
    res.json({ stores: stores.map((s) => ({ id: s.id, storeCode: s.storeCode, storeName: s.storeName, storeNameAr: s.storeNameAr })) });
});

// Items for the draft's "add item" search, with each variant's available
// qty in the source store so the user sees what can actually be sent.
router.get('/store-transfers/item-search', requireTransfer, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const storeId = Number(req.query.storeId);
    if (q.length < 2 || !storeId) return res.json({ items: [] });
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
    const shaped = [];
    for (const i of items) {
        const own = variants.filter((v) => v.itemId === i.id);
        const options = own.length
            ? own.map((v) => ({ color: v.color, lengthMm: v.lengthMm, barcode: v.barcode }))
            : [{ color: null, lengthMm: null, barcode: i.barcode ?? null }];
        for (const o of options) o.available = await getAvailableToReserve(storeId, i.id, o.color ?? null, o.lengthMm ?? null);
        shaped.push({ id: i.id, itemCode: i.itemCode, itemName: i.itemName, itemNameAr: i.itemNameAr, baseUnit: i.baseUnit, options });
    }
    res.json({ items: shaped });
});

// Open outstanding lines across every sent / partially-received transfer
// -- the "In transit" tab on the Reports page, so .reports holders see it
// too, not only people who move stock. Declared before /:id.
function requireTransferOrReports(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    getPermissionsForRole(req.user.role).then((granted) => {
        if (granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_TRANSFER) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS)) {
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }).catch((err) => {
        console.error('Permission check failed:', err);
        res.status(500).json({ success: false, message: 'Permission check failed' });
    });
}

router.get('/store-transfers/in-transit', requireTransferOrReports, async (req, res) => {
    const where = { status: OPEN_STATUSES };
    if (req.query.storeId) {
        const sid = Number(req.query.storeId);
        where[Op.or] = [{ fromStoreId: sid }, { toStoreId: sid }];
    }
    const transfers = await MatWhStoreTransfer.findAll({ where, order: [['sentAt', 'ASC']] });
    if (!transfers.length) return res.json({ items: [] });
    const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transfers.map((t) => t.id) } });
    const open = lines.filter((l) => l.qtySent - l.qtyReceived > 0.000001);
    const [shaped, stores] = await Promise.all([
        shapeLines(open),
        storeMap([...new Set(transfers.flatMap((t) => [t.fromStoreId, t.toStoreId]))]),
    ]);
    const byId = new Map(transfers.map((t) => [t.id, withStores(t, stores)]));
    res.json({
        items: shaped.map((l) => {
            const t = byId.get(l.storeTransferId);
            return {
                ...l, transferNo: t.transferNo, status: t.status, sentAt: t.sentAt,
                fromStoreCode: t.fromStoreCode, fromStoreName: t.fromStoreName, fromStoreNameAr: t.fromStoreNameAr,
                toStoreCode: t.toStoreCode, toStoreName: t.toStoreName, toStoreNameAr: t.toStoreNameAr,
                valueInTransit: l.unitCost != null ? l.qtyOutstanding * l.unitCost : null,
            };
        }),
    });
});

router.get('/store-transfers', requireTransfer, async (req, res) => {
    const where = {};
    if (req.query.status) where.status = String(req.query.status).split(',');
    if (req.query.storeId) {
        const sid = Number(req.query.storeId);
        if (req.query.direction === 'in') where.toStoreId = sid;
        else if (req.query.direction === 'out') where.fromStoreId = sid;
        else where[Op.or] = [{ fromStoreId: sid }, { toStoreId: sid }];
    }
    const transfers = await MatWhStoreTransfer.findAll({ where, order: [['id', 'DESC']], limit: 200 });
    const ids = transfers.map((t) => t.id);
    const [stores, lines] = await Promise.all([
        storeMap([...new Set(transfers.flatMap((t) => [t.fromStoreId, t.toStoreId]))]),
        ids.length
            ? MatWhStoreTransferLine.findAll({ attributes: ['storeTransferId', 'qtySent', 'qtyReceived'], where: { storeTransferId: ids }, raw: true })
            : [],
    ]);
    const totals = new Map();
    for (const l of lines) {
        const t = totals.get(l.storeTransferId) || { lineCount: 0, qtySent: 0, qtyReceived: 0 };
        t.lineCount += 1;
        t.qtySent += l.qtySent;
        t.qtyReceived += l.qtyReceived;
        totals.set(l.storeTransferId, t);
    }
    res.json({
        items: transfers.map((t) => ({
            ...withStores(t, stores),
            ...(totals.get(t.id) || { lineCount: 0, qtySent: 0, qtyReceived: 0 }),
        })),
    });
});

router.get('/store-transfers/:id', requireTransfer, async (req, res) => {
    try {
        const transfer = await loadTransfer(Number(req.params.id));
        const lines = await MatWhStoreTransferLine.findAll({ where: { storeTransferId: transfer.id }, order: [['id', 'ASC']] });
        const [shaped, stores] = await Promise.all([shapeLines(lines), storeMap([transfer.fromStoreId, transfer.toStoreId])]);
        // While still a draft, show how much of each line the source store
        // can actually send right now.
        if (transfer.status === 'draft') {
            for (const l of shaped) {
                l.availableAtSource = await getAvailableToReserve(transfer.fromStoreId, l.itemId, l.color ?? null, l.lengthMm ?? null);
            }
        }
        res.json({ ...withStores(transfer, stores), lines: shaped });
    } catch (err) {
        sendError(res, err, 'Failed to load transfer');
    }
});

router.post('/store-transfers', requireTransfer, async (req, res) => {
    try {
        const { fromStoreId, toStoreId, notes } = req.body || {};
        if (fromStoreId && await denyStore(req, res, Number(fromStoreId))) return;
        res.status(201).json(await createTransfer({ fromStoreId, toStoreId, notes, createdBy: req.user.userId }));
    } catch (err) {
        sendError(res, err, 'Failed to create transfer');
    }
});

router.post('/store-transfers/:id/lines', requireTransfer, requireTransferStore('from'), async (req, res) => {
    if (!req.body?.itemId) return res.status(400).json({ message: 'itemId is required' });
    try {
        res.status(201).json(await addLine(Number(req.params.id), req.body));
    } catch (err) {
        sendError(res, err, 'Failed to add item');
    }
});

router.put('/store-transfers/:id/lines/:lineId', requireTransfer, requireTransferStore('from'), async (req, res) => {
    try {
        res.json(await updateLine(Number(req.params.id), Number(req.params.lineId), req.body?.qty));
    } catch (err) {
        sendError(res, err, 'Failed to update line');
    }
});

router.delete('/store-transfers/:id/lines/:lineId', requireTransfer, requireTransferStore('from'), async (req, res) => {
    try {
        await removeLine(Number(req.params.id), Number(req.params.lineId));
        res.json({ success: true });
    } catch (err) {
        sendError(res, err, 'Failed to remove line');
    }
});

router.post('/store-transfers/:id/send', requireTransfer, requireTransferStore('from'), async (req, res) => {
    try {
        res.json(await sendTransfer(Number(req.params.id), req.user.userId));
    } catch (err) {
        sendError(res, err, 'Failed to send transfer');
    }
});

router.post('/store-transfers/:id/receive', requireTransfer, requireTransferStore('to'), async (req, res) => {
    try {
        res.json(await receiveLines(Number(req.params.id), req.body?.lines, req.user.userId));
    } catch (err) {
        sendError(res, err, 'Failed to receive transfer');
    }
});

router.post('/store-transfers/:id/cancel', requireTransfer, requireTransferStore('from'), async (req, res) => {
    try {
        res.json(await cancelTransfer(Number(req.params.id)));
    } catch (err) {
        sendError(res, err, 'Failed to cancel transfer');
    }
});

router.get('/store-transfers/:id/lookup', requireTransfer, async (req, res) => {
    const code = String(req.query.barcode || '').trim();
    if (!code) return res.status(400).json({ message: 'barcode is required' });
    try {
        const { line, resolved } = await lookupBarcode(Number(req.params.id), code);
        res.json({ line: line ? (await shapeLines([line]))[0] : null, resolved });
    } catch (err) {
        sendError(res, err, 'Lookup failed');
    }
});

export default router;
