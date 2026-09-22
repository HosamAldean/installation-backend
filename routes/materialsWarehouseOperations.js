// backend/routes/materialsWarehouseOperations.js
// WH.3: Reservations, feasibility checks, and external processing (e.g.
// coating) -- the warehouse-operations layer on top of WH.2's receipts,
// per the Alpha Warehouse Analysis report §10. Confirming a reservation/
// feasibility checks don't move physical stock (Stock House's own
// precedent, §07) and never touch matWhStockLedger; issuing a confirmed
// reservation line and external processing both do.
import express from 'express';
import { Op } from 'sequelize';
import { sequelize2PetraErp, sequelizeUtf8 } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhReservationHeader } from '../models/MatWhReservationHeader.js';
import { MatWhReservationItem } from '../models/MatWhReservationItem.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { MatWhItemStore } from '../models/MatWhItemStore.js';
import { MatWhFeasibilityCheck } from '../models/MatWhFeasibilityCheck.js';
import { MatWhExternalProcessing } from '../models/MatWhExternalProcessing.js';
import { MatWhPurchaseOrder } from '../models/MatWhPurchaseOrder.js';
import { MatWhPurchaseOrderItem } from '../models/MatWhPurchaseOrderItem.js';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { postLedgerMovement, getAvailableToReserve, getAlreadyReserved, getPendingQty, getPhysicalBalance } from '../services/matWhLedger.js';
import {
    createReservationHeader, submitReservation,
    confirmReservation, rejectReservation,
    confirmReservationLine, rejectReservationLine,
    issueReservationLine, computeHeaderStatus,
} from '../services/matWhReservations.js';

const router = express.Router();
router.use(authenticateToken);

const requireReserve = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE);
const requireIssue = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE);
const requireReceive = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE);
const requireReports = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS);

// A handful of read endpoints here are legitimately needed by more than
// one role (checking availability before reserving vs. before issuing).
// Built on getPermissionsForRole directly rather than composing
// requirePermission calls -- that middleware writes the 401/403 response
// itself on failure, which can't be un-sent to fall through and try the
// next key.
function requireAnyOf(...keys) {
    return async (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (req.user.role === 'admin') return next();
        try {
            const granted = await getPermissionsForRole(req.user.role);
            if (keys.some((k) => granted.includes(k))) return next();
            res.status(403).json({ success: false, message: 'Forbidden' });
        } catch (err) {
            console.error('Permission check failed:', err);
            res.status(500).json({ success: false, message: 'Permission check failed' });
        }
    };
}

// ============================================================
// Stock balance / ledger (read)
// ============================================================

router.get('/stock-balance', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
), async (req, res) => {
    const storeId = parseInt(req.query.storeId);
    const itemId = parseInt(req.query.itemId);
    if (!storeId || !itemId) return res.status(400).json({ message: 'storeId and itemId are required' });
    // excludeLineId lets a reservation line already counted in
    // alreadyReserved exclude itself when re-checking availability while
    // being edited (not yet used by the frontend, but avoids the line
    // double-counting against its own hold if that's added later).
    const excludeLineId = req.query.excludeLineId ? Number(req.query.excludeLineId) : undefined;
    // Omitted entirely -> undefined -> pooled total across every color,
    // unchanged from before color-awareness existed. Only a caller that
    // actually knows the color (ReservationDetail.tsx's ALM line entry)
    // passes one.
    const color = req.query.color || undefined;
    const [physicalBalance, alreadyReserved, pendingQty, itemStore] = await Promise.all([
        getPhysicalBalance(storeId, itemId, color),
        getAlreadyReserved(storeId, itemId, excludeLineId, color),
        getPendingQty(storeId, itemId, excludeLineId, color),
        MatWhItemStore.findOne({ where: { storeId, itemId } }),
    ]);
    res.json({
        storeId, itemId, color: color ?? null, physicalBalance, alreadyReserved, pendingQty,
        availableToReserve: physicalBalance - alreadyReserved,
        // General location of this item's pooled stock in this store (WH
        // gap #9) -- null when never recorded, same as no location data
        // existing at all.
        zone: itemStore?.zone ?? null,
        locationColumn: itemStore?.locationColumn ?? null,
        locationRow: itemStore?.locationRow ?? null,
    });
});

// ============================================================
// Item/store lookups -- for the reservation line entry, gated the same as
// stock-balance rather than requiring MATERIALS_WAREHOUSE_MASTER_DATA
// (materialsWarehouse.js's own /items and /stores lists) which a
// storekeeper holding only .reserve/.issue/.receive was never granted.
//
// Named store-lookup/item-lookup, NOT nested under /stores or /items --
// materialsWarehouse.js (WH.1) is mounted at this same /api/materials-
// warehouse base ahead of this router and already owns GET /stores/:id and
// GET /items/:id there. A /stores/lookup or /items/lookup path here would
// never actually be reached: Express would match it against that other
// router's :id route first (id="lookup"), either 403'ing under
// MATERIALS_WAREHOUSE_MASTER_DATA or 404'ing on a literal id lookup --
// confirmed live, this was the exact cause of the reservation screen's
// store dropdown coming back empty.
// ============================================================

router.get('/store-lookup', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
), async (req, res) => {
    const rows = await MatWhStore.findAll({ where: { isActive: true }, order: [['storeName', 'ASC']] });
    res.json({ items: rows });
});

// Also reachable with .purchase_orders/.purchasing -- a manually-created
// PO's line-item picker (PurchaseOrders.tsx) needs the same lookup a
// reservation/issue/receive flow already uses.
router.get('/item-lookup', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING,
), async (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ message: 'code is required' });
    const item = await MatWhItem.findOne({ where: { itemCode: code } });
    if (!item) return res.status(404).json({ message: 'Item not found' });
    // storeIds: which real store(s) this item is actually kept in (see
    // MatWhItemStore.js) -- empty means no evidence either way, treated as
    // store-flexible by the caller (any store selectable), never a guess.
    const itemStores = await MatWhItemStore.findAll({ where: { itemId: item.id }, attributes: ['storeId'] });
    res.json({ ...item.toJSON(), storeIds: itemStores.map((s) => s.storeId) });
});

// Type-ahead item search by partial code or name -- item-lookup above
// stays an exact-code lookup (a barcode scan or a typed exact code
// resolves in one call), this is the fuzzy counterpart for a technician
// who doesn't know the exact code, same idea as /color-lookup's
// suggestion list but server-side filtered/capped: matWhItems has ~8,725
// rows, too many to ship to the client whole like the 574-row color list.
router.get('/item-search', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING,
), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const items = await MatWhItem.findAll({
        where: {
            isActive: true,
            [Op.or]: [
                { itemCode: { [Op.like]: `%${q}%` } },
                { itemName: { [Op.like]: `%${q}%` } },
                { itemNameAr: { [Op.like]: `%${q}%` } },
            ],
        },
        order: [['itemCode', 'ASC']],
        limit: 30,
    });
    const itemStores = await MatWhItemStore.findAll({
        where: { itemId: items.map((i) => i.id) },
        attributes: ['itemId', 'storeId'],
    });
    const storesByItem = new Map();
    for (const row of itemStores) {
        if (!storesByItem.has(row.itemId)) storesByItem.set(row.itemId, []);
        storesByItem.get(row.itemId).push(row.storeId);
    }
    res.json({
        items: items.map((i) => ({ ...i.toJSON(), storeIds: storesByItem.get(i.id) || [] })),
    });
});

// Resolves a specific set of item ids in one call -- for displaying
// already-known lines (a reservation's or PO's own items table), NOT for
// picking a new one (that's item-lookup/item-search above). Exists
// because ReservationDetail.tsx/PurchaseOrderDetail.tsx used to fetch a
// generic "first N items" list and .find() a line's itemId in it --
// silently broken for the vast majority of the real 8,725-item catalog
// (worse still, EVERY aluminum item, category='ALM', has a higher id than
// that capped list's range, so zero of them ever resolved), showing a
// bare numeric id instead of the item's name. Fetching exactly the ids a
// page actually needs has no such ceiling.
router.get('/items-by-ids', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING,
), async (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    if (ids.length === 0) return res.json({ items: [] });
    const items = await MatWhItem.findAll({ where: { id: ids } });
    res.json({ items });
});

// Real aluminum coating color master (IIT_Petra.colorInfo, joined to
// colorType so the filter is by name -- 'AL' -- not a hardcoded id that
// could differ across environments) -- 574 real mix codes/RAL colors, the
// same list Petra's own coating/CR09 side already uses. This is what a
// reservation line's aluminum color select (ReservationDetail.tsx) is
// populated from, replacing the old free-text input -- per direct
// request, "look in the mysql database" rather than let a storekeeper
// type any string. Named /color-lookup, not nested under /lookups --
// routes/lookups.js's own endpoints require the broader, admin-oriented
// LOOKUPS_VIEW permission that a plain storekeeper role was never granted;
// this follows the same narrowly-gated store-lookup/item-lookup precedent
// right above instead.
router.get('/color-lookup', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS,
    PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING,
), async (req, res) => {
    const rows = await sequelize2PetraErp.query(
        `SELECT ci.colorInfoId, ci.mixCode, ci.code, ci.colorDesc
         FROM colorInfo ci
         JOIN colorType ct ON ct.colorTypeId = ci.colorTypeId
         WHERE ct.colorTypeName = 'AL'
         ORDER BY ci.colorDesc, ci.mixCode`,
        { type: sequelize2PetraErp.QueryTypes.SELECT },
    );
    res.json({
        // Petra's own colorInfo data has occasional stray whitespace/
        // newlines on mixCode (e.g. one live row is "\r\nMX3012NM35") --
        // trimmed here rather than in the source table, which isn't ours
        // to touch, so nothing gets stored on our own reservation lines
        // with leading/trailing junk.
        items: rows.map((r) => {
            const desc = r.colorDesc?.trim();
            const code = r.code?.trim();
            const mix = r.mixCode?.trim();
            // mixCode leads -- it's the actual identifier purchasing/
            // mixing orders against, the description/RAL code are just
            // human-readable context in parens after it. Falls back to
            // the description-first form on the rare row with no mixCode
            // at all (mixCode is expected on every real AL row, but never
            // assumed).
            const detail = [desc, code].filter(Boolean).join(' - ');
            const label = mix
                ? (detail ? `${mix} (${detail})` : mix)
                : (detail || code || '');
            return {
                id: r.colorInfoId,
                mixCode: mix,
                code,
                colorDesc: desc,
                label,
            };
        }),
    });
});

// ============================================================
// Project lookup -- fills in the reservation header's project name/manager
// from IIT_Petra.project + .user.
//
// Uses sequelize2PetraErp, NOT plain sequelize2 -- that connection's own
// header comment in config/db.js documents exactly this bug for exactly
// this table ("Client.js-read Arabic names ... rendered as
// 'Ø§Ø¨Ø±Ø§Ù‡ÙŠÙ…...' before this fix"), confirmed live here too: plain
// sequelize2 handed back mojibake for project.projectName, and a plain
// fixArabic() post-process on it does NOT recover the original text --
// it produces different, WORSE-mangled output (confirmed live, and two
// real reservation rows + their auto-generated PO briefly got corrupted
// data written from exactly this mistake before this fix landed; restored
// from a live re-read via this same correct connection). Fetch through
// the connection with the right typeCast in the first place instead.
// ============================================================

router.get('/projects/search', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });

    const rows = await sequelize2PetraErp.query(
        `SELECT projectId, projectNo, projectName, projectManagerId
         FROM project
         WHERE projectNo LIKE :q OR projectName LIKE :q
         ORDER BY projectNo DESC
         LIMIT 10`,
        { replacements: { q: `%${q}%` }, type: sequelize2PetraErp.QueryTypes.SELECT },
    );

    const managerIds = [...new Set(rows.map((r) => r.projectManagerId).filter(Boolean))];
    const managerNameById = new Map();
    if (managerIds.length) {
        const managers = await sequelize2PetraErp.query(
            'SELECT userId, firstName, lastName FROM `user` WHERE userId IN (:ids)',
            { replacements: { ids: managerIds }, type: sequelize2PetraErp.QueryTypes.SELECT },
        );
        for (const m of managers) {
            managerNameById.set(m.userId, [m.firstName, m.lastName].filter(Boolean).join(' '));
        }
    }

    res.json({
        items: rows.map((r) => ({
            projectId: r.projectId,
            projectNo: r.projectNo,
            projectName: r.projectName,
            projectManager: r.projectManagerId ? (managerNameById.get(r.projectManagerId) ?? null) : null,
        })),
    });
});

router.get('/stock-ledger', requireReports, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const where = {};
    if (req.query.storeId) where.storeId = req.query.storeId;
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.docType) where.docType = req.query.docType;

    const { count, rows } = await MatWhStockLedger.findAndCountAll({
        where, limit: pageSize, offset: (page - 1) * pageSize, order: [['id', 'DESC']],
    });
    res.json({ total: count, items: rows });
});

// ============================================================
// Reservations -- one header per project, one or more item lines. A header
// starts 'draft' (lines can be added/removed freely), then Confirm
// Reservation (POST /reservations/:id/confirm) reserves whatever's
// available on every line at once and raises an auto-PO for any shortfall
// -- see services/matWhReservations.js.
// ============================================================

// Store managers need to read the reservation list/detail too (the Store
// Manager dashboard's whole point), even without holding .reserve
// themselves -- everything that actually changes a reservation stays
// .reserve-only, just these two GETs are widened.
router.get('/reservations', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER,
), async (req, res) => {
    const where = {};
    if (req.query.projectId) where.projectId = req.query.projectId;
    if (req.query.status) where.status = req.query.status;
    const rows = await MatWhReservationHeader.findAll({ where, order: [['id', 'DESC']] });
    res.json({ items: rows });
});

router.get('/reservations/:id', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER,
), async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Not found' });
    const items = await MatWhReservationItem.findAll({
        where: { reservationHeaderId: header.id }, order: [['id', 'ASC']],
    });

    // Surface each line's linked PO item's targetColor, if any -- lets the
    // UI explain why a partially_confirmed line's auto-PO shows color: null
    // (it's a mill-finish buy headed for coating, see matWhReservations.js's
    // confirmOneLine/confirmReservation).
    const poItemIds = [...new Set(items.map((i) => i.purchaseOrderItemId).filter(Boolean))];
    const poItemById = poItemIds.length > 0
        ? new Map((await MatWhPurchaseOrderItem.findAll({ where: { id: poItemIds } })).map((p) => [p.id, p]))
        : new Map();
    const itemsWithTargetColor = items.map((i) => ({
        ...i.toJSON(),
        targetColor: poItemById.get(i.purchaseOrderItemId)?.targetColor ?? null,
    }));

    res.json({ ...header.toJSON(), items: itemsWithTargetColor });
});

router.post('/reservations', requireReserve, async (req, res) => {
    const { reservationNo, projectId, projectNo, projectName, projectManager, requestedByName, reservedUntilDate, notes } = req.body;
    if (!reservationNo || !String(reservationNo).trim()) {
        return res.status(400).json({ message: 'reservationNo is required' });
    }
    if (!projectId) return res.status(400).json({ message: 'projectId is required' });
    try {
        const header = await createReservationHeader({
            reservationNo: String(reservationNo).trim(),
            projectId, projectNo, projectName, projectManager, requestedByName, reservedUntilDate, notes,
            createdBy: req.user.userId,
        });
        res.status(201).json(header);
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A reservation with that number already exists' });
        }
        console.error('Error creating reservation:', err);
        res.status(500).json({ message: 'Failed to create reservation' });
    }
});

// Adds one item line to a still-draft header. Rejects outright if the
// requested qty is already known to exceed what's available -- confirm can
// still cover a shortfall with an auto-PO, but a line shouldn't silently
// invite one for a typo'd quantity before the storekeeper even looks at it.
router.post('/reservations/:id/items', requireReserve, async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Reservation not found' });
    if (header.status !== 'draft') {
        return res.status(409).json({ message: `Cannot add items to a reservation in status '${header.status}'` });
    }
    const { itemId, storeId, itemNeededByDate, color, lengthMm, qtyRequested } = req.body;
    if (!itemId || !storeId || !qtyRequested) {
        return res.status(400).json({ message: 'itemId, storeId and qtyRequested are required' });
    }
    // Same positivity check the bulk endpoint below already has -- a
    // negative or zero qty (e.g. a typo'd "-1") shouldn't be storable at
    // all, let alone silently earmark/shortfall against it at confirm time.
    if (!Number.isFinite(Number(qtyRequested)) || Number(qtyRequested) <= 0) {
        return res.status(400).json({ message: 'qtyRequested must be a positive number' });
    }
    const line = await MatWhReservationItem.create({
        reservationHeaderId: header.id, itemId, storeId,
        itemNeededByDate: itemNeededByDate ?? null,
        color: color || null, lengthMm: lengthMm || null,
        qtyRequested,
        status: 'pending',
    });
    res.status(201).json(line);
});

// Adds many lines to a still-draft header in one request -- the friendly
// path for populating a reservation with 50-100 items at once (the grid on
// ReservationDetail.tsx), instead of one POST /items round trip per line.
// Resolves itemCode -> itemId server-side (the frontend only has to send
// codes, not pre-resolve every one via /item-lookup itself) and validates
// color against the same real AL color master /color-lookup exposes -- an
// unrecognized color is dropped with a per-line warning rather than
// failing the whole line, since qty is the part that actually matters.
//
// storeId is now PER LINE, not once for the whole request -- each item
// routes to its own real store (MatWhItemStore.js). If the item has known
// store(s), the given storeId must be one of them (rejected otherwise --
// a technician can't reserve stock from a store that item has no real
// evidence of ever being in); an item with no known stores at all is
// store-flexible, any real store accepted, per direct decision (never
// block reserving an item just because nobody's recorded where it lives).
router.post('/reservations/:id/items/bulk', requireReserve, async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Reservation not found' });
    if (header.status !== 'draft') {
        return res.status(409).json({ message: `Cannot add items to a reservation in status '${header.status}'` });
    }
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ message: 'lines must be a non-empty array' });
    }

    const colorRows = await sequelize2PetraErp.query(
        `SELECT ci.mixCode, ci.code FROM colorInfo ci
         JOIN colorType ct ON ct.colorTypeId = ci.colorTypeId
         WHERE ct.colorTypeName = 'AL'`,
        { type: sequelize2PetraErp.QueryTypes.SELECT },
    );
    const validColorKeys = new Set();
    for (const c of colorRows) {
        if (c.mixCode) validColorKeys.add(c.mixCode.trim().toUpperCase());
        if (c.code) validColorKeys.add(c.code.trim().toUpperCase());
    }

    const results = [];
    for (const rawLine of lines) {
        const itemCode = String(rawLine?.itemCode || '').trim();
        const qtyRequested = Number(rawLine?.qtyRequested);
        if (!itemCode) continue; // silently skip genuinely blank pasted lines

        if (!Number.isFinite(qtyRequested) || qtyRequested <= 0) {
            results.push({ itemCode, qtyRequested: rawLine?.qtyRequested ?? null, success: false, error: 'Invalid quantity' });
            continue;
        }

        const storeId = Number(rawLine?.storeId) || null;
        if (!storeId) {
            results.push({ itemCode, qtyRequested, success: false, error: 'Store is required' });
            continue;
        }

        const item = await MatWhItem.findOne({ where: { itemCode } });
        if (!item) {
            results.push({ itemCode, qtyRequested, success: false, error: 'Item not found' });
            continue;
        }

        const knownStoreIds = (await MatWhItemStore.findAll({ where: { itemId: item.id }, attributes: ['storeId'] }))
            .map((s) => s.storeId);
        if (knownStoreIds.length > 0 && !knownStoreIds.includes(storeId)) {
            results.push({ itemCode, qtyRequested, success: false, error: 'This item has no record of being in that store' });
            continue;
        }

        let color = null;
        let warning;
        const rawColor = String(rawLine?.color || '').trim();
        if (rawColor) {
            if (validColorKeys.has(rawColor.toUpperCase())) {
                color = rawColor;
            } else {
                warning = `Unrecognized color "${rawColor}" -- left blank`;
            }
        }
        const lengthMm = rawLine?.lengthMm ? Number(rawLine.lengthMm) || null : null;

        const line = await MatWhReservationItem.create({
            reservationHeaderId: header.id, itemId: item.id, storeId,
            color, lengthMm, qtyRequested, status: 'pending',
        });
        results.push({
            itemCode, qtyRequested, success: true, lineId: line.id, itemName: item.itemName, warning,
        });
    }

    res.status(201).json({
        created: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
    });
});

router.delete('/reservations/:id/items/:lineId', requireReserve, async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Reservation not found' });
    if (header.status !== 'draft') {
        return res.status(409).json({ message: `Cannot remove items from a reservation in status '${header.status}'` });
    }
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: header.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    await line.destroy();
    res.json({ message: 'removed' });
});

// Locks the header (no more item add/remove) and sends every line to its
// own store for an independent confirm/reject decision -- WM 10-21's "sent
// to store" moment.
router.post('/reservations/:id/submit', requireReserve, async (req, res) => {
    try {
        const header = await submitReservation(Number(req.params.id));
        res.json(header);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to submit reservation' });
    }
});

// Bulk convenience: every still-pending line at once.
router.post('/reservations/:id/confirm', requireReserve, async (req, res) => {
    try {
        const result = await confirmReservation(Number(req.params.id), req.user.userId);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to confirm reservation' });
    }
});

// Bulk convenience: rejects every still-pending line with one shared
// reason.
router.post('/reservations/:id/reject', requireReserve, async (req, res) => {
    try {
        const result = await rejectReservation(Number(req.params.id), req.user.userId, req.body?.reason);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to reject reservation' });
    }
});

// WM 10-21's real per-store decision -- confirm or reject exactly one
// line, independent of every other line on the same reservation.
router.post('/reservations/:id/items/:lineId/confirm', requireReserve, async (req, res) => {
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: req.params.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    try {
        const result = await confirmReservationLine(line.id, req.user.userId);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to confirm line' });
    }
});

router.post('/reservations/:id/items/:lineId/reject', requireReserve, async (req, res) => {
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: req.params.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    try {
        const result = await rejectReservationLine(line.id, req.user.userId, req.body?.reason);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to reject line' });
    }
});

// "Compensation" -- covers some or all of a shortfall line's still-owed
// quantity with a DIFFERENT item/color/length that's actually available
// right now, instead of only ever waiting on the shortfall's already-
// raised auto-PO (left untouched here, same "don't implicitly touch an
// already-raised PO" precedent /release documents). The substitute is
// created as its OWN new confirmed line on the same header/store -- not a
// mutation of the original line -- so the original keeps recording what
// was actually requested, and the new line records what was actually
// handed over instead. Same actor as Confirm (.reserve): this is a
// store's own decision about how to cover a shortfall it already owns.
router.post('/reservations/:id/items/:lineId/substitute', requireReserve, async (req, res) => {
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: req.params.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    if (line.status !== 'partially_confirmed') {
        return res.status(409).json({ message: `Cannot substitute on a line in status '${line.status}' -- only a real shortfall can be covered this way` });
    }

    const { itemId, color, lengthMm } = req.body;
    const qty = Number(req.body.qty);
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });
    if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ message: 'qty must be a positive number' });
    }
    if (qty > Number(line.qtyShortfall) + 0.0001) {
        return res.status(409).json({ message: `Only ${line.qtyShortfall} still owed on this line -- cannot substitute more than that` });
    }
    if (Number(itemId) === line.itemId) {
        return res.status(400).json({ message: 'That is the same item this line already requested -- nothing to substitute' });
    }

    const substituteItem = await MatWhItem.findByPk(itemId);
    if (!substituteItem) return res.status(400).json({ message: `Unknown item id: ${itemId}` });

    const available = await getAvailableToReserve(line.storeId, itemId, color || undefined);
    if (available < qty) {
        return res.status(409).json({ message: `Only ${available} of the substitute item available at this store`, available });
    }

    const t = await sequelizeUtf8.transaction();
    try {
        const substituteLine = await MatWhReservationItem.create({
            reservationHeaderId: line.reservationHeaderId, itemId, storeId: line.storeId,
            color: color || null, lengthMm: lengthMm ?? null,
            qtyRequested: qty, qtyReserved: qty, qtyShortfall: 0,
            status: 'confirmed', reservedBy: req.user.userId, reservedDate: new Date(),
            substitutesLineId: line.id,
        }, { transaction: t });

        const remainingShortfall = Number(line.qtyShortfall) - qty;
        await line.update({
            qtyShortfall: Math.max(0, remainingShortfall),
            status: remainingShortfall > 0.0001 ? 'partially_confirmed' : 'confirmed',
        }, { transaction: t });

        await t.commit();
        res.status(201).json({ originalLine: line, substituteLine });
    } catch (err) {
        await t.rollback();
        console.error('Error substituting reservation line:', err);
        res.status(500).json({ message: 'Failed to substitute item' });
    }
});

// Applies newly-available stock of the EXACT item/color a shortfall line is
// still owed -- the counterpart to Substitute above, for the case
// Substitute can't handle: the coating loop returns the SAME item (just now
// available in the requested color), and Substitute explicitly rejects a
// same-itemId substitute. Deliberately generic, not coating-specific -- any
// route that adds real stock (a plain receipt, a return, a manual ledger
// correction) can also be what a storekeeper is reacting to here, not just
// a coating receive. Deliberately NOT auto-called from external-processing
// receive: more than one line can be waiting on the same item+color, so a
// storekeeper decides allocation explicitly, one click per line. Also
// deliberately leaves the line's already-raised PO/coating job untouched,
// same "don't implicitly touch a live PO" precedent /release documents.
router.post('/reservations/:id/items/:lineId/fulfill-shortfall', requireReserve, async (req, res) => {
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: req.params.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    if (line.status !== 'partially_confirmed') {
        return res.status(409).json({ message: `Cannot fulfill shortfall on a line in status '${line.status}' -- only a real shortfall can be covered this way` });
    }

    const available = await getAvailableToReserve(line.storeId, line.itemId, line.color ?? undefined);
    if (!(available > 0)) {
        return res.status(409).json({ message: 'No newly-available stock for this item/color yet', available });
    }

    const qtyToApply = Math.min(Number(line.qtyShortfall), available);
    const remainingShortfall = Number(line.qtyShortfall) - qtyToApply;
    await line.update({
        qtyReserved: Number(line.qtyReserved) + qtyToApply,
        qtyShortfall: Math.max(0, remainingShortfall),
        status: remainingShortfall > 0.0001 ? 'partially_confirmed' : 'confirmed',
    });
    res.json(line);
});

// Storekeeper's physical hand-over of one confirmed line (WM 10-22) --
// deliberately a distinct permission from Confirm (.reserve, the
// production-supervisor approval on WM 10-21): a reservation can be fully
// approved by a supervisor and still sit unissued until a storekeeper
// with .issue actually hands the material over.
router.post('/reservations/:id/items/:lineId/issue', requireIssue, async (req, res) => {
    const line = await MatWhReservationItem.findOne({
        where: { id: req.params.lineId, reservationHeaderId: req.params.id },
    });
    if (!line) return res.status(404).json({ message: 'Line not found' });
    try {
        const result = await issueReservationLine(line.id, req.user.userId, req.body?.issuedBarcode, req.body?.issuePurpose);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to issue line' });
    }
});

// GET /issue-candidates?itemId=X -- the item-first entry point into
// issuing, mirroring goods-receipt-candidates' reasoning on the receiving
// side (materialsWarehousePurchasing.js): a storekeeper who knows the item
// shouldn't have to open every reservation individually to find which ones
// are waiting on it. Returns every confirmed/partially-confirmed line for
// this item, across ALL reservations, still awaiting its physical hand-
// over (WM 10-22) -- an item can easily have more than one, e.g. two
// different projects both confirmed against the same item.
router.get('/issue-candidates', requireIssue, async (req, res) => {
    const itemId = Number(req.query.itemId);
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });

    const lines = await MatWhReservationItem.findAll({
        where: {
            itemId,
            status: { [Op.in]: ['confirmed', 'partially_confirmed'] },
            qtyReserved: { [Op.gt]: 0 },
        },
    });
    if (lines.length === 0) return res.json({ items: [] });

    const headerIds = [...new Set(lines.map((l) => l.reservationHeaderId))];
    const headers = await MatWhReservationHeader.findAll({ where: { id: headerIds } });
    const headerById = new Map(headers.map((h) => [h.id, h]));

    const storeIds = [...new Set(lines.map((l) => l.storeId))];
    const stores = storeIds.length > 0 ? await MatWhStore.findAll({ where: { id: storeIds } }) : [];
    const storeById = new Map(stores.map((s) => [s.id, s]));

    // Where this item's pooled stock is generally kept in each candidate
    // store (WH gap #9) -- lets the storekeeper see where to go before
    // committing to issue.
    const itemStores = storeIds.length > 0
        ? await MatWhItemStore.findAll({ where: { itemId, storeId: storeIds } })
        : [];
    const itemStoreByStoreId = new Map(itemStores.map((s) => [s.storeId, s]));

    // A line's own shortfall auto-PO (WH gap #4b) -- can't be a real
    // physical trace (the ledger is pooled, not lot-tracked -- see
    // services/matWhLedger.js), so this is surfaced as informational
    // context only: "this line's shortfall was covered by PO #X", not a
    // claim that the exact units being issued came from it.
    const poIds = [...new Set(lines.map((l) => l.purchaseOrderId).filter(Boolean))];
    const pos = poIds.length > 0 ? await MatWhPurchaseOrder.findAll({ where: { id: poIds } }) : [];
    const poById = new Map(pos.map((p) => [p.id, p]));

    const candidates = lines.map((l) => {
        const header = headerById.get(l.reservationHeaderId);
        const itemStore = itemStoreByStoreId.get(l.storeId);
        return {
            lineId: l.id,
            reservationHeaderId: l.reservationHeaderId,
            reservationNo: header?.reservationNo ?? null,
            projectName: header?.projectName ?? null,
            requestedByName: header?.requestedByName ?? null,
            storeId: l.storeId,
            storeName: storeById.get(l.storeId)?.storeName ?? null,
            zone: itemStore?.zone ?? null,
            locationColumn: itemStore?.locationColumn ?? null,
            locationRow: itemStore?.locationRow ?? null,
            qtyReserved: l.qtyReserved,
            status: l.status,
            color: l.color,
            lengthMm: l.lengthMm,
            purchaseOrderId: l.purchaseOrderId,
            purchaseOrderNo: l.purchaseOrderId ? (poById.get(l.purchaseOrderId)?.poNo ?? null) : null,
        };
    });
    res.json({ items: candidates });
});

// Same action as the route above, reachable directly by line id -- the
// item-first Issue by Item page doesn't know (and shouldn't need to look
// up) which reservation a candidate line belongs to just to issue it;
// issueReservationLine itself only ever needed the line id anyway.
router.post('/reservation-items/:lineId/issue', requireIssue, async (req, res) => {
    try {
        const result = await issueReservationLine(
            Number(req.params.lineId), req.user.userId, req.body?.issuedBarcode, req.body?.issuePurpose,
        );
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message || 'Failed to issue line' });
    }
});

// Sums this line's already-returned quantity across every prior return
// movement -- live-computed off the ledger (the single source of truth for
// stock movements) rather than a cached counter, same convention as
// materialsWarehousePurchasing.js's own getReceivedSoFar for goods
// receipts. Used to stop a project from "returning" more than it was
// actually issued.
async function getReturnedSoFar(lineId) {
    const rows = await MatWhStockLedger.findAll({
        where: { refType: 'reservation_item_return', refId: lineId },
        attributes: ['qty'],
    });
    return rows.reduce((sum, r) => sum + Number(r.qty), 0);
}

// Material physically returned from a project back into a store -- the
// piece this module was missing entirely on the item-level ledger (Profile
// Store has its own separate MatWhProfileReturn for per-piece aluminum;
// this is the main-flow equivalent, closing that gap). Deliberately scoped
// to reversing a specific ISSUED reservation line rather than a free-
// standing "return anything" action -- a return only makes sense against
// material that was actually handed out through this system in the first
// place, and tying it to the line keeps the audit trail (who issued it,
// to which project, now returned how much of it) intact. Reuses .receive
// (same actor who already accepts goods receipts) rather than a new key.
router.post('/reservation-items/:lineId/return', requireReceive, async (req, res) => {
    const line = await MatWhReservationItem.findByPk(req.params.lineId);
    if (!line) return res.status(404).json({ message: 'Line not found' });
    if (line.status !== 'issued') {
        return res.status(409).json({ message: `Cannot return a line in status '${line.status}' -- only an issued line has stock out to return` });
    }
    const qty = Number(req.body?.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ message: 'qty must be a positive number' });
    }
    const returnedSoFar = await getReturnedSoFar(line.id);
    if (returnedSoFar + qty > Number(line.qtyReserved) + 0.0001) {
        return res.status(409).json({
            message: `Only ${Number(line.qtyReserved) - returnedSoFar} still returnable on this line (issued ${line.qtyReserved}, already returned ${returnedSoFar})`,
        });
    }

    const header = await MatWhReservationHeader.findByPk(line.reservationHeaderId);
    const ledgerRow = await postLedgerMovement({
        storeId: line.storeId, itemId: line.itemId, projectId: header?.projectId ?? null,
        qty, direction: 'in', docType: 'return',
        refType: 'reservation_item_return', refId: line.id,
        performedBy: req.user.userId, color: line.color ?? null,
    });
    res.status(201).json({ ledgerRow, returnedSoFar: returnedSoFar + qty, qtyReserved: line.qtyReserved });
});

// Releases every held line on a confirmed reservation -- e.g. the project
// no longer needs the material. Lines already covered by an auto-PO keep
// that PO (canceling a purchase already raised is a separate, explicit
// action on the Purchase Orders page, not an implicit side effect here).
router.post('/reservations/:id/release', requireReserve, async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Not found' });
    if (header.status !== 'confirmed') {
        return res.status(409).json({ message: `Cannot release a reservation in status '${header.status}'` });
    }
    const lines = await MatWhReservationItem.findAll({ where: { reservationHeaderId: header.id } });
    for (const line of lines) {
        if (['confirmed', 'partially_confirmed'].includes(line.status)) {
            await line.update({ status: 'released', releasedDate: new Date() });
        }
    }
    await header.update({ status: computeHeaderStatus(lines) });
    res.json(header);
});

// Reassigns a reservation to a different project -- header-level only (a
// reservation is one project covering several items, not the other way
// around, so "transfer" moves the whole header, never a single line).
// Blocked once every line is terminal (issued/released/rejected -- nothing
// left to actually reassign, the material's already gone one way or the
// other for the OLD project). Deliberately does NOT touch matWhStockLedger
// or any already-issued line's own historical record: postLedgerMovement
// snapshots projectId at issue time, so an already-issued line's ledger
// row keeps recording the project it was actually handed over to,
// regardless of a later transfer -- exactly the same "don't rewrite
// history" reasoning release's own comment already documents for an
// already-raised auto-PO.
router.post('/reservations/:id/transfer', requireReserve, async (req, res) => {
    const header = await MatWhReservationHeader.findByPk(req.params.id);
    if (!header) return res.status(404).json({ message: 'Not found' });
    if (['issued', 'released', 'rejected'].includes(header.status)) {
        return res.status(409).json({ message: `Cannot transfer a reservation in status '${header.status}' -- nothing left to reassign` });
    }
    const { projectId, projectNo, projectName, projectManager } = req.body;
    if (!projectId) return res.status(400).json({ message: 'projectId is required' });
    if (Number(projectId) === header.projectId) {
        return res.status(400).json({ message: 'This reservation is already assigned to that project' });
    }

    await header.update({
        previousProjectId: header.projectId,
        previousProjectNo: header.projectNo,
        previousProjectName: header.projectName,
        transferredBy: req.user.userId,
        transferredDate: new Date(),
        projectId, projectNo: projectNo ?? null, projectName: projectName ?? null,
        projectManager: projectManager ?? null,
    });
    res.json(header);
});

// ============================================================
// Feasibility checks -- pre-reservation, doesn't earmark anything itself.
// ============================================================

router.post('/feasibility-checks', requireReserve, async (req, res) => {
    const { itemId, storeId, projectId, productionRef, qtyRequested, color } = req.body;
    if (!itemId || !storeId || !qtyRequested) {
        return res.status(400).json({ message: 'itemId, storeId and qtyRequested are required' });
    }
    const available = await getAvailableToReserve(storeId, itemId, color || undefined);
    const status = Number(qtyRequested) <= available ? 'feasible' : 'not_feasible';
    const row = await MatWhFeasibilityCheck.create({
        itemId, storeId, projectId: projectId ?? null, productionRef: productionRef ?? null,
        color: color || null, qtyRequested, status, checkedBy: req.user.userId, checkedDate: new Date(),
    });
    res.status(201).json({ ...row.toJSON(), availableAtCheckTime: available });
});

router.get('/feasibility-checks', requireReserve, async (req, res) => {
    const where = {};
    if (req.query.projectId) where.projectId = req.query.projectId;
    if (req.query.itemId) where.itemId = req.query.itemId;
    const rows = await MatWhFeasibilityCheck.findAll({ where, order: [['id', 'DESC']] });
    res.json({ items: rows });
});

// ============================================================
// External processing -- a real physical movement out of and back into
// the store, unlike reservations. Send is an issue-shaped action; receive
// is a receive-shaped one, so they're gated by different keys.
// ============================================================

router.get('/external-processing', requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
), async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.storeId) where.storeId = req.query.storeId;
    const rows = await MatWhExternalProcessing.findAll({ where, order: [['id', 'DESC']] });

    // Resolve the originating reservation for auto-generated coating jobs
    // (see POST /goods-receipts' targetColor branch) so the frontend can
    // link back without a separate round trip -- same batched-lookup style
    // as issue-candidates above.
    const sourceLineIds = [...new Set(rows.map((r) => r.sourceReservationItemId).filter(Boolean))];
    const sourceLines = sourceLineIds.length > 0
        ? await MatWhReservationItem.findAll({ where: { id: sourceLineIds } })
        : [];
    const lineById = new Map(sourceLines.map((l) => [l.id, l]));
    const headerIds = [...new Set(sourceLines.map((l) => l.reservationHeaderId))];
    const headers = headerIds.length > 0
        ? await MatWhReservationHeader.findAll({ where: { id: headerIds } })
        : [];
    const headerById = new Map(headers.map((h) => [h.id, h]));

    const items = rows.map((r) => {
        const sourceLine = r.sourceReservationItemId ? lineById.get(r.sourceReservationItemId) : null;
        const sourceHeader = sourceLine ? headerById.get(sourceLine.reservationHeaderId) : null;
        return {
            ...r.toJSON(),
            reservationHeaderId: sourceHeader?.id ?? null,
            reservationNo: sourceHeader?.reservationNo ?? null,
        };
    });
    res.json({ items });
});

router.post('/external-processing', requireIssue, async (req, res) => {
    const { itemId, storeId, processVendorId, qtySent } = req.body;
    if (!itemId || !storeId || !qtySent) {
        return res.status(400).json({ message: 'itemId, storeId and qtySent are required' });
    }
    const available = await getAvailableToReserve(storeId, itemId);
    if (Number(qtySent) > available) {
        return res.status(409).json({ message: `Only ${available} available to send`, available });
    }

    const row = await MatWhExternalProcessing.create({
        itemId, storeId, processVendorId: processVendorId ?? null, qtySent,
        sentDate: new Date(), sentBy: req.user.userId,
    });
    await postLedgerMovement({
        storeId, itemId, qty: qtySent, direction: 'out', docType: 'external_send',
        refType: 'external_processing', refId: row.id, performedBy: req.user.userId,
    });
    res.status(201).json(row);
});

router.post('/external-processing/:id/receive', requireReceive, async (req, res) => {
    const row = await MatWhExternalProcessing.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.status !== 'sent') {
        return res.status(409).json({ message: `Cannot receive a job in status '${row.status}'` });
    }
    // Real-world coating loss means qtyReceived can be less than qtySent
    // -- caller may pass an actual figure, defaulting to qtySent if the
    // whole batch came back.
    const qtyReceived = req.body.qtyReceived !== undefined ? Number(req.body.qtyReceived) : row.qtySent;

    await row.update({ qtyReceived, status: 'received', receivedDate: new Date(), receivedBy: req.user.userId });
    if (qtyReceived > 0) {
        await postLedgerMovement({
            storeId: row.storeId, itemId: row.itemId, qty: qtyReceived, direction: 'in',
            docType: 'external_receive', refType: 'external_processing', refId: row.id,
            performedBy: req.user.userId, color: row.targetColor ?? null,
        });
    }
    res.json(row);
});

// Confirms an auto-created draft coating job (see POST /goods-receipts'
// targetColor branch): a storekeeper must always pick the vendor by hand --
// there's no safe default across multiple real coating partners -- and this
// is the point the physical send becomes real, posting the external_send
// ledger movement. Mirrors the existing auto-PO's own "raised automatically,
// confirmed explicitly" shape. Manually-created jobs (POST /external-
// processing) never pass through here -- they start at 'sent' already.
router.post('/external-processing/:id/confirm-send', requireIssue, async (req, res) => {
    const row = await MatWhExternalProcessing.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Not found' });
    if (row.status !== 'draft') {
        return res.status(409).json({ message: `Cannot confirm-send a job in status '${row.status}'` });
    }
    const { processVendorId } = req.body;
    if (!processVendorId) {
        return res.status(400).json({ message: 'processVendorId is required' });
    }
    const qtySent = req.body.qtySent !== undefined ? Number(req.body.qtySent) : row.qtySent;

    // Mill-finish stock is the untargeted (null-color) pool -- pass null
    // explicitly (not row.targetColor, and not undefined/pooled). The
    // external_send movement this route posts below always writes
    // color: null, so what it actually debits is the null-color balance
    // specifically; checking against the ALL-colors pooled total
    // (undefined) could pass on the strength of other colors' stock that
    // this movement never touches, then still drive the null-color balance
    // negative once posted. The check has to scope to the same color the
    // write uses.
    const available = await getAvailableToReserve(row.storeId, row.itemId, null);
    if (qtySent > available) {
        return res.status(409).json({ message: `Only ${available} available to send`, available });
    }

    await postLedgerMovement({
        storeId: row.storeId, itemId: row.itemId, qty: qtySent, direction: 'out',
        docType: 'external_send', refType: 'external_processing', refId: row.id,
        performedBy: req.user.userId, color: null,
    });
    await row.update({
        status: 'sent', processVendorId, qtySent,
        sentBy: req.user.userId, sentDate: new Date(),
    });
    res.json(row);
});

export default router;
