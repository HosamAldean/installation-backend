// backend/routes/materialsWarehousePurchasing.js
// WH.2: Purchase Order -> Goods Receipt -> Supplier Invoice, per the Alpha
// Warehouse Analysis report §10. Three permission keys, not one -- a
// storekeeper (MATERIALS_WAREHOUSE_RECEIVE) can create goods receipts and
// never touches MATERIALS_WAREHOUSE_INVOICES, which accounting holds
// instead. This is the concrete fix for "any storekeeper can add invoice."
//
// Receipt and invoicing are deliberately decoupled (§10, §08): creating a
// goods receipt never requires an invoice to exist first, and posting a
// supplier invoice against a receipt that's already been received doesn't
// undo anything already recorded -- it just fills in finalUnitCost and
// flips invoiceStatus. As of WH.3, a goods receipt posts an 'in' ledger
// movement per accepted quantity the moment it's created, and a matched
// invoice trues up that movement's cost if finalUnitCost differs from the
// provisional figure -- see services/matWhLedger.js.
import express from 'express';
import { Op } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelizeUtf8, sequelize2PetraErp } from '../config/db.js';
import { MatWhPurchaseOrder } from '../models/MatWhPurchaseOrder.js';
import { MatWhPurchaseOrderItem } from '../models/MatWhPurchaseOrderItem.js';
import { MatWhGoodsReceipt } from '../models/MatWhGoodsReceipt.js';
import { MatWhGoodsReceiptItem } from '../models/MatWhGoodsReceiptItem.js';
import { MatWhQcResult } from '../models/MatWhQcResult.js';
import { MatWhSupplierInvoice } from '../models/MatWhSupplierInvoice.js';
import { MatWhSupplierInvoiceItem } from '../models/MatWhSupplierInvoiceItem.js';
import { MatWhStockLedger } from '../models/MatWhStockLedger.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { Vendor } from '../models/Vendor.js';
import { postLedgerMovement, applyReceiptCost } from '../services/matWhLedger.js';

const router = express.Router();
router.use(authenticateToken);

const requirePurchaseOrders = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS);
const requireReceive = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE);
const requireInvoices = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_INVOICES);
const requireReserve = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE);
const requireStoreManager = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER);

// Purchasing-department staff (a new, distinct group -- see
// MATERIALS_WAREHOUSE_PURCHASING's own comment) need the same read/action
// access to POs that .purchase_orders already has, without necessarily
// holding that broader key themselves. requirePermission responds directly
// on failure rather than calling next(err), so it can't be composed as an
// "either" check -- this does the same role-list check directly instead,
// same pattern as materialsWarehouseOperations.js's own requireAnyOf.
// Deliberately NOT given to .store_manager here -- a store manager can
// read (see requirePurchaseOrdersReadAccess below) and use their own
// dedicated /manager-confirm action, but shouldn't get vendor-assignment/
// confirm/send write access just for being able to review the PO.
function requirePurchaseOrdersOrPurchasing(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    getPermissionsForRole(req.user.role).then((granted) => {
        if (granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING)) {
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }).catch((err) => {
        console.error('Permission check failed:', err);
        res.status(500).json({ success: false, message: 'Permission check failed' });
    });
}

// Read-only superset of the above, adding .store_manager -- used only on
// the two GET routes below (list + detail), so a store manager can find
// what's awaiting their confirmation on the Store Manager dashboard and
// open a PO's detail page to actually click Approve there.
function requirePurchaseOrdersReadAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    getPermissionsForRole(req.user.role).then((granted) => {
        if (granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING) ||
            granted.includes(PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER)) {
            return next();
        }
        res.status(403).json({ success: false, message: 'Forbidden' });
    }).catch((err) => {
        console.error('Permission check failed:', err);
        res.status(500).json({ success: false, message: 'Permission check failed' });
    });
}

// ============================================================
// Purchase Orders
// ============================================================

router.get('/purchase-orders', requirePurchaseOrdersReadAccess, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.vendorId) where.vendorId = req.query.vendorId;
    // Lets the Store Manager dashboard ask for exactly what's awaiting
    // that manager's own confirmation (?internalApprovalStatus=pending_manager).
    if (req.query.internalApprovalStatus) where.internalApprovalStatus = req.query.internalApprovalStatus;

    const { count, rows } = await MatWhPurchaseOrder.findAndCountAll({
        where, limit: pageSize, offset: (page - 1) * pageSize, order: [['id', 'DESC']],
    });
    res.json({ total: count, items: rows });
});

router.get('/purchase-orders/:id', requirePurchaseOrdersReadAccess, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    const items = await MatWhPurchaseOrderItem.findAll({ where: { purchaseOrderId: po.id } });
    res.json({ ...po.toJSON(), items });
});

// Shared per-line shape validation -- same rule set the create route and
// the add-item route below both need (qty positive, price zero-or-
// positive, length positive-if-given, itemId present). Returns an error
// message string, or null if the line is well-formed; doesn't check
// itemId/color against the DB since those need a batched query the
// caller is better positioned to do once for however many lines it has.
function validatePoLineShape(line, label) {
    const qty = Number(line.qtyOrdered);
    const price = Number(line.unitPrice);
    if (!line.itemId) return `${label}: itemId is required`;
    if (!Number.isFinite(qty) || qty <= 0) return `${label}: qtyOrdered must be a positive number`;
    // unitPrice may legitimately be 0 -- an auto-generated shortfall line
    // doesn't know a price yet (see the model comment), filled in by hand
    // later same as any other draft PO line. Only a negative price is
    // nonsensical.
    if (!Number.isFinite(price) || price < 0) return `${label}: unitPrice must be zero or a positive number`;
    if (line.lengthMm != null && line.lengthMm !== '') {
        const length = Number(line.lengthMm);
        if (!Number.isFinite(length) || length <= 0) return `${label}: lengthMm must be a positive number`;
    }
    return null;
}

// Same real AL color master the reservation bulk-add endpoint validates
// against -- a manually-typed/hand-crafted request could otherwise store
// a color that resolves to nothing on display. Returns true if valid (or
// not provided at all).
async function isValidPoLineColor(color) {
    if (!color) return true;
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
    return validColorKeys.has(String(color).trim().toUpperCase());
}

router.post('/purchase-orders', requirePurchaseOrders, async (req, res) => {
    const {
        poNo, vendorId, destinationStoreId, isLC, eta, port, shipTerms, freightExpense, items,
        // Optional -- lets a buyer tag a manually-created PO to a project
        // too, same fields an auto-generated PO gets from its reservation
        // (see services/matWhReservations.js). Not required: most manual
        // POs are general restocking, not tied to one project.
        projectId, projectNo, projectName, notes,
    } = req.body;
    if (!poNo || !vendorId || !destinationStoreId) {
        return res.status(400).json({ message: 'poNo, vendorId and destinationStoreId are required' });
    }

    const lineItems = Array.isArray(items) ? items : [];
    if (lineItems.length === 0) {
        return res.status(400).json({ message: 'At least one line item is required' });
    }

    // Validate each line's shape before touching the DB or a vendor/
    // store/item lookup -- a typo'd negative qty (same class of bug as
    // the reservation grid's own "-1" case) or a bogus itemId shouldn't
    // silently create a PO line pointing at nothing / worth nothing.
    for (const [idx, line] of lineItems.entries()) {
        const err = validatePoLineShape(line, `Line ${idx + 1}`);
        if (err) return res.status(400).json({ message: err });
    }

    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(400).json({ message: 'Unknown vendorId' });
    const store = await MatWhStore.findByPk(destinationStoreId);
    if (!store) return res.status(400).json({ message: 'Unknown destinationStoreId' });

    const itemIds = [...new Set(lineItems.map((l) => Number(l.itemId)))];
    const foundItems = await MatWhItem.findAll({ where: { id: itemIds } });
    if (foundItems.length !== itemIds.length) {
        const foundIds = new Set(foundItems.map((i) => i.id));
        const missing = itemIds.filter((id) => !foundIds.has(id));
        return res.status(400).json({ message: `Unknown item id(s): ${missing.join(', ')}` });
    }

    for (const line of lineItems) {
        if (line.color && !(await isValidPoLineColor(line.color))) {
            return res.status(400).json({ message: `Unrecognized color: ${line.color}` });
        }
    }

    const t = await sequelizeUtf8.transaction();
    try {
        const netAmt = lineItems.reduce((sum, i) => sum + Number(i.qtyOrdered) * Number(i.unitPrice), 0);

        const po = await MatWhPurchaseOrder.create({
            poNo, vendorId, destinationStoreId, isLC: !!isLC, eta, port, shipTerms,
            freightExpense, netAmt, createdBy: req.user.userId,
            projectId: projectId ?? null, projectNo: projectNo ?? null,
            projectName: projectName ?? null, notes: notes ?? null,
        }, { transaction: t });

        for (const line of lineItems) {
            await MatWhPurchaseOrderItem.create({
                purchaseOrderId: po.id,
                itemId: line.itemId,
                qtyOrdered: line.qtyOrdered,
                unitPrice: line.unitPrice,
                lineAmt: Number(line.qtyOrdered) * Number(line.unitPrice),
                neededByDate: line.neededByDate ?? null,
                color: line.color || null,
                lengthMm: line.lengthMm ?? null,
            }, { transaction: t });
        }

        await t.commit();
        res.status(201).json({ id: po.id });
    } catch (err) {
        await t.rollback();
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'A PO with that number already exists' });
        }
        console.error('Error creating purchase order:', err);
        res.status(500).json({ message: 'Failed to create purchase order' });
    }
});

// Adds one line item to an EXISTING purchase order -- the one gap this
// module had against Reservations, which already support adding a line to
// an existing draft header. Only ever allowed while the PO is still
// 'draft' (once sent/confirmed/etc, its lines are what a vendor has
// already acknowledged against); same permission and per-line validation
// as the create route above (factored into validatePoLineShape/
// isValidPoLineColor so the two stay in lockstep rather than drifting).
router.post('/purchase-orders/:id/items', requirePurchaseOrders, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (po.status !== 'draft') {
        return res.status(409).json({ message: `Cannot add items to a PO in status '${po.status}'` });
    }

    const { itemId, qtyOrdered, unitPrice, color, lengthMm } = req.body;
    const shapeErr = validatePoLineShape(req.body, 'Item');
    if (shapeErr) return res.status(400).json({ message: shapeErr });

    const item = await MatWhItem.findByPk(itemId);
    if (!item) return res.status(400).json({ message: `Unknown item id: ${itemId}` });

    if (color && !(await isValidPoLineColor(color))) {
        return res.status(400).json({ message: `Unrecognized color: ${color}` });
    }

    const t = await sequelizeUtf8.transaction();
    try {
        const lineAmt = Number(qtyOrdered) * Number(unitPrice);
        const line = await MatWhPurchaseOrderItem.create({
            purchaseOrderId: po.id,
            itemId,
            qtyOrdered,
            unitPrice,
            lineAmt,
            color: color || null,
            lengthMm: lengthMm ?? null,
        }, { transaction: t });
        await po.update({ netAmt: Number(po.netAmt || 0) + lineAmt }, { transaction: t });
        await t.commit();
        res.status(201).json(line);
    } catch (err) {
        await t.rollback();
        console.error('Error adding purchase order item:', err);
        res.status(500).json({ message: 'Failed to add item' });
    }
});

// Assign/change vendor -- the case that actually needed this: an
// auto-generated PO for an item with no preferredVendorId is created with
// vendorId left null (see services/matWhReservations.js) for someone to
// fill in by hand. Locked once goods have been received or an invoice
// matched -- changing the vendor after stock/cost has already moved under
// the old one would leave the ledger/costing pointing at the wrong party.
router.patch('/purchase-orders/:id/vendor', requirePurchaseOrdersOrPurchasing, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (['received', 'invoiced', 'closed'].includes(po.status)) {
        return res.status(409).json({ message: `Cannot change vendor on a PO in status '${po.status}'` });
    }
    const { vendorId } = req.body;
    if (!vendorId) return res.status(400).json({ message: 'vendorId is required' });
    await po.update({ vendorId });
    res.json(po);
});

// Vendor acknowledgment step (§08) -- distinct from "received", which is a
// storekeeper action on a different endpoint below.
router.post('/purchase-orders/:id/confirm', requirePurchaseOrdersOrPurchasing, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (!['draft', 'sent'].includes(po.status)) {
        return res.status(409).json({ message: `Cannot confirm a PO in status '${po.status}'` });
    }
    await po.update({ status: 'confirmed', orderConfirmedDate: new Date() });
    res.json(po);
});

router.post('/purchase-orders/:id/send', requirePurchaseOrdersOrPurchasing, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (po.status !== 'draft') {
        return res.status(409).json({ message: `Cannot send a PO in status '${po.status}'` });
    }
    // An auto-generated PO must clear the storekeeper->manager review chain
    // first -- sending it to the vendor before that would defeat the whole
    // point of the chain. A manually-created PO is 'not_required' from
    // creation and is never blocked here.
    if (po.internalApprovalStatus !== 'not_required' && po.internalApprovalStatus !== 'approved') {
        return res.status(409).json({ message: 'This PO still needs storekeeper and store-manager confirmation before it can be sent' });
    }
    await po.update({ status: 'sent' });
    res.json(po);
});

// Storekeeper's confirmation that this auto-generated PO's data is
// complete/correct -- the reservation line that raised it was confirmed
// under .reserve, so this reuses that same permission rather than
// introducing a third new key for the same actor.
router.post('/purchase-orders/:id/storekeeper-confirm', requireReserve, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (!po.isAutoGenerated) {
        return res.status(409).json({ message: 'Only auto-generated purchase orders go through this review' });
    }
    if (po.internalApprovalStatus !== 'pending_storekeeper') {
        return res.status(409).json({ message: `Cannot confirm a PO with internal approval status '${po.internalApprovalStatus}'` });
    }
    await po.update({
        internalApprovalStatus: 'pending_manager',
        storekeeperConfirmedBy: req.user.userId, storekeeperConfirmedDate: new Date(),
    });
    res.json(po);
});

// Store manager's confirmation, the second and final internal review step
// -- once this lands, purchasing (.purchasing or .purchase_orders) can act
// on the PO same as any other.
router.post('/purchase-orders/:id/manager-confirm', requireStoreManager, async (req, res) => {
    const po = await MatWhPurchaseOrder.findByPk(req.params.id);
    if (!po) return res.status(404).json({ message: 'Not found' });
    if (po.internalApprovalStatus !== 'pending_manager') {
        return res.status(409).json({ message: `Cannot confirm a PO with internal approval status '${po.internalApprovalStatus}'` });
    }
    await po.update({
        internalApprovalStatus: 'approved',
        managerConfirmedBy: req.user.userId, managerConfirmedDate: new Date(),
    });
    res.json(po);
});

// ============================================================
// Goods Receipts -- storekeeper territory. Never requires an invoice.
// ============================================================

router.get('/goods-receipts', requireReceive, async (req, res) => {
    const where = {};
    if (req.query.purchaseOrderId) where.purchaseOrderId = req.query.purchaseOrderId;
    if (req.query.invoiceStatus) where.invoiceStatus = req.query.invoiceStatus;
    const rows = await MatWhGoodsReceipt.findAll({ where, order: [['id', 'DESC']] });
    res.json({ items: rows });
});

// Every receipt still 'pending' more than 7 days after receivedDate --
// the real, observed lag from the Alpha Warehouse Analysis report §10, not
// a hypothetical threshold. Declared before /:id so it isn't swallowed by
// that param route.
router.get('/goods-receipts/overdue-invoices', requireReceive, async (req, res) => {
    const days = Math.max(1, parseInt(req.query.days) || 7);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await MatWhGoodsReceipt.findAll({
        where: { invoiceStatus: 'pending', receivedDate: { [Op.lt]: cutoff } },
        order: [['receivedDate', 'ASC']],
    });
    res.json({ items: rows, thresholdDays: days });
});

router.get('/goods-receipts/:id', requireReceive, async (req, res) => {
    const gr = await MatWhGoodsReceipt.findByPk(req.params.id);
    if (!gr) return res.status(404).json({ message: 'Not found' });
    const items = await MatWhGoodsReceiptItem.findAll({ where: { goodsReceiptId: gr.id } });
    res.json({ ...gr.toJSON(), items });
});

// Creates the receipt header + QC'd line items in one call. Cost starts
// provisional (PO item's unitPrice unless a receipt-time override is
// given) and stock is considered usable from this moment regardless of
// invoice status -- posting into matWhStockLedger is WH.3's job.
router.post('/goods-receipts', requireReceive, async (req, res) => {
    const {
        purchaseOrderId, shipmentRef, landCost, locExpenses, othExpenses, items,
        // Both optional -- default to now, same as before, but let the
        // storekeeper backdate either one to when the material/QC actually
        // happened instead of when it was typed into the system (e.g.
        // entering a receipt a day late shouldn't misrepresent when the
        // truck actually arrived).
        receivedDate, qcCheckedDate,
    } = req.body;
    if (!purchaseOrderId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'purchaseOrderId and at least one item are required' });
    }

    const po = await MatWhPurchaseOrder.findByPk(purchaseOrderId);
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });

    const poItems = await MatWhPurchaseOrderItem.findAll({ where: { purchaseOrderId } });
    const poItemById = new Map(poItems.map((i) => [i.id, i]));

    const t = await sequelizeUtf8.transaction();
    try {
        const gr = await MatWhGoodsReceipt.create({
            purchaseOrderId, shipmentRef, landCost, locExpenses, othExpenses,
            receivedDate: receivedDate ? new Date(receivedDate) : new Date(),
            qcCheckedBy: req.user.userId,
            qcCheckedDate: qcCheckedDate ? new Date(qcCheckedDate) : new Date(),
            receivedBy: req.user.userId,
        }, { transaction: t });

        for (const line of items) {
            const poItem = line.poItemId ? poItemById.get(Number(line.poItemId)) : null;
            const qtyAccepted = Number(line.qtyAccepted ?? line.qtyReceived) || 0;
            const qtyLoss = Number(line.qtyLoss) || 0;
            const qtyRejected = Number(line.qtyRejected) || 0;
            const provisionalUnitCost = line.provisionalUnitCost ?? poItem?.unitPrice ?? null;

            const grItem = await MatWhGoodsReceiptItem.create({
                goodsReceiptId: gr.id,
                poItemId: poItem?.id ?? null,
                itemId: line.itemId,
                qtyReceived: line.qtyReceived,
                qtyAccepted, qtyLoss, qtyRejected,
                provisionalUnitCost,
            }, { transaction: t });

            // Only the accepted quantity is usable stock -- lost/rejected
            // quantity was never really received (§07's QC pattern). This
            // is what makes the material reservable/issuable immediately,
            // independent of the invoice (§10).
            if (qtyAccepted > 0) {
                const ledgerRow = await postLedgerMovement({
                    storeId: po.destinationStoreId,
                    itemId: line.itemId,
                    qty: qtyAccepted,
                    direction: 'in',
                    docType: 'receipt',
                    refType: 'goods_receipt_item',
                    refId: grItem.id,
                    unitCost: provisionalUnitCost,
                    performedBy: req.user.userId,
                }, t);
                await grItem.update({ ledgerEntryId: ledgerRow.id }, { transaction: t });
                // WH.4: feeds the running valuation (matWhItemCost) from
                // this receipt's provisional cost.
                await applyReceiptCost(line.itemId, po.destinationStoreId, qtyAccepted, provisionalUnitCost, t);
            }
        }

        // Only advance status forward -- a PO that's already 'invoiced' or
        // 'closed' (invoice arrived before this receipt was entered) stays
        // put; this is exactly the "can happen in either order" case.
        if (['draft', 'sent', 'confirmed'].includes(po.status)) {
            await po.update({ status: 'received' }, { transaction: t });
        }

        await t.commit();
        res.status(201).json({ id: gr.id });
    } catch (err) {
        await t.rollback();
        console.error('Error creating goods receipt:', err);
        res.status(500).json({ message: 'Failed to create goods receipt' });
    }
});

// Categorized QC findings for one received line (§10) -- additive detail
// alongside the plain qtyAccepted/qtyLoss/qtyRejected totals, not a
// replacement for them.
router.post('/goods-receipt-items/:id/qc-results', requireReceive, async (req, res) => {
    const grItem = await MatWhGoodsReceiptItem.findByPk(req.params.id);
    if (!grItem) return res.status(404).json({ message: 'Not found' });

    const { qcCategoryId, qty, notes } = req.body;
    if (!qcCategoryId || qty === undefined) {
        return res.status(400).json({ message: 'qcCategoryId and qty are required' });
    }
    const row = await MatWhQcResult.create({ goodsReceiptItemId: grItem.id, qcCategoryId, qty, notes });
    res.status(201).json(row);
});

router.get('/goods-receipt-items/:id/qc-results', requireReceive, async (req, res) => {
    const rows = await MatWhQcResult.findAll({ where: { goodsReceiptItemId: req.params.id } });
    res.json({ items: rows });
});

// ============================================================
// Supplier Invoices -- accounting territory only.
// ============================================================

router.get('/supplier-invoices', requireInvoices, async (req, res) => {
    const where = {};
    if (req.query.purchaseOrderId) where.purchaseOrderId = req.query.purchaseOrderId;
    const rows = await MatWhSupplierInvoice.findAll({ where, order: [['id', 'DESC']] });
    res.json({ items: rows });
});

router.get('/supplier-invoices/:id', requireInvoices, async (req, res) => {
    const inv = await MatWhSupplierInvoice.findByPk(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Not found' });
    const items = await MatWhSupplierInvoiceItem.findAll({ where: { supplierInvoiceId: inv.id } });
    res.json({ ...inv.toJSON(), items });
});

// Creates the invoice and, if it names a goodsReceiptId, matches back to
// it in the same transaction: flips that receipt's invoiceStatus to
// 'matched' and fills finalUnitCost on its items from the invoice's own
// line prices (matched by itemId). A cost gap between provisionalUnitCost
// and finalUnitCost is a variance to review, not corrected automatically.
router.post('/supplier-invoices', requireInvoices, async (req, res) => {
    const {
        purchaseOrderId, goodsReceiptId, vendorInvoiceNo, invDate, invDueDate, items,
        // Optional, defaults to now -- when the vendor's invoice document
        // was actually received/logged, distinct from invDate (the date
        // printed on the invoice itself, which can trail well behind).
        invReceivedDate,
    } = req.body;
    if (!purchaseOrderId || !vendorInvoiceNo || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'purchaseOrderId, vendorInvoiceNo and at least one item are required' });
    }

    const po = await MatWhPurchaseOrder.findByPk(purchaseOrderId);
    if (!po) return res.status(404).json({ message: 'Purchase order not found' });

    const t = await sequelizeUtf8.transaction();
    try {
        const netAmt = items.reduce((sum, i) => sum + Number(i.qty) * Number(i.unitPrice), 0);
        const matchStatus = goodsReceiptId ? 'matched' : 'unmatched';

        const inv = await MatWhSupplierInvoice.create({
            purchaseOrderId, goodsReceiptId: goodsReceiptId ?? null, vendorInvoiceNo,
            invDate, invDueDate, netAmt, matchStatus,
            invReceivedDate: invReceivedDate ? new Date(invReceivedDate) : new Date(),
            enteredBy: req.user.userId,
        }, { transaction: t });

        const unitPriceByItemId = new Map();
        for (const line of items) {
            await MatWhSupplierInvoiceItem.create({
                supplierInvoiceId: inv.id,
                itemId: line.itemId,
                qty: line.qty,
                unitPrice: line.unitPrice,
                lineAmt: Number(line.qty) * Number(line.unitPrice),
            }, { transaction: t });
            unitPriceByItemId.set(Number(line.itemId), Number(line.unitPrice));
        }

        if (goodsReceiptId) {
            const gr = await MatWhGoodsReceipt.findByPk(goodsReceiptId, { transaction: t });
            if (gr) {
                await gr.update({ invoiceStatus: 'matched' }, { transaction: t });
                const grItems = await MatWhGoodsReceiptItem.findAll({ where: { goodsReceiptId }, transaction: t });
                for (const grItem of grItems) {
                    const finalUnitCost = unitPriceByItemId.get(grItem.itemId);
                    if (finalUnitCost === undefined) continue;
                    await grItem.update({ finalUnitCost }, { transaction: t });

                    // True up the ledger row's cost to the actual invoiced
                    // price -- a gap from provisionalUnitCost is a real
                    // cost variance (§10), not silently ignored. Only
                    // touches cost fields, never the quantity already
                    // posted.
                    if (grItem.ledgerEntryId) {
                        await MatWhStockLedger.update(
                            { unitCost: finalUnitCost, totalCost: finalUnitCost * grItem.qtyAccepted },
                            { where: { id: grItem.ledgerEntryId }, transaction: t },
                        );
                    }
                }
            }
            if (['draft', 'sent', 'confirmed', 'received'].includes(po.status)) {
                await po.update({ status: 'invoiced' }, { transaction: t });
            }
        }

        await t.commit();
        res.status(201).json({ id: inv.id });
    } catch (err) {
        await t.rollback();
        console.error('Error creating supplier invoice:', err);
        res.status(500).json({ message: 'Failed to create supplier invoice' });
    }
});

export default router;
