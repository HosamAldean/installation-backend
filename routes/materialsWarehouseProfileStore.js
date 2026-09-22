// backend/routes/materialsWarehouseProfileStore.js
// Profile Store sub-module of Materials Warehouse -- the aluminum-profile
// (profile+color+length, barcode-identified, store-scoped) workflow that
// replaces Stock House's guest.EnterDou*/ReservationO*/StockOut*/
// StockBack*/MIXO*/ReservationFO* tables and guest.ItemProfile/ProfileNOA
// catalogs. See models/MatWhProfile*.js for the full per-table rationale.
//
// Every transaction endpoint below resolves its item via `barcode` (falling
// back to profileCatalogId+color+lengthMm+storeId to create a new
// profileStock row on first use, same as Stock House's own
// resolveComputerNo/POST /enter behavior) rather than a raw profileStockId,
// so the barcode genuinely is the thing staff scan/type at every step.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission, getPermissionsForRole } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { MatWhProfileCatalog } from '../models/MatWhProfileCatalog.js';
import { MatWhProfileAssembly } from '../models/MatWhProfileAssembly.js';
import { MatWhProfileStock } from '../models/MatWhProfileStock.js';
import { MatWhProfileReceipt } from '../models/MatWhProfileReceipt.js';
import { MatWhProfileReservation } from '../models/MatWhProfileReservation.js';
import { MatWhProfileShipment } from '../models/MatWhProfileShipment.js';
import { MatWhProfileReturn } from '../models/MatWhProfileReturn.js';
import { MatWhProfileCoatingBatch } from '../models/MatWhProfileCoatingBatch.js';
import { MatWhProfileTransfer } from '../models/MatWhProfileTransfer.js';
import { MatWhProfileFeasibilityCheck } from '../models/MatWhProfileFeasibilityCheck.js';
import {
    getPhysicalBalance, getAvailableToReserve, resolveProfileStock, findProfileStockByBarcode,
} from '../services/matWhProfileStock.js';
import { Op } from 'sequelize';

const router = express.Router();
router.use(authenticateToken);

const requireReceive = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE);
const requireReserve = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE);
const requireIssue = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE);
const requireCoating = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_COATING);
const requireTransfer = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_TRANSFER);
const requireReports = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS);
const requireCatalog = requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_CATALOG);

// A handful of read endpoints are legitimately needed by more than one
// role -- same reasoning/shape as materialsWarehouseOperations.js's own
// requireAnyOf.
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

const requireAnyStockAccess = requireAnyOf(
    PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE,
    PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE,
    PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_COATING,
    PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_TRANSFER,
    PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS,
);

function paging(req) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    return { page, pageSize, offset: (page - 1) * pageSize };
}

// Every transaction table stores profileStockId, not the barcode itself --
// list endpoints attach it here (one batched lookup, not N+1) so the
// frontend's history tables can show the barcode staff actually recognize
// instead of a raw internal id.
async function attachBarcodes(rows) {
    const ids = [...new Set(rows.map((r) => r.profileStockId).filter(Boolean))];
    if (!ids.length) return rows.map((r) => ({ ...r.toJSON(), barcode: null }));
    const stocks = await MatWhProfileStock.findAll({ where: { id: ids } });
    const byId = new Map(stocks.map((s) => [s.id, s.barcode]));
    return rows.map((r) => ({ ...r.toJSON(), barcode: byId.get(r.profileStockId) ?? null }));
}

// Resolves the profileStock row a transaction should act on: an explicit
// stockId wins, otherwise barcode is looked up (and, when
// profileCatalogId+color+lengthMm+storeId are also supplied, created if it
// doesn't exist yet -- first-time receipt of a new combination).
async function resolveStock(body) {
    const { stockId, barcode, profileCatalogId, color, lengthMm, storeId, zone, locationColumn, locationRow } = body;
    if (stockId) return MatWhProfileStock.findByPk(stockId);
    if (barcode) {
        const found = await MatWhProfileStock.findOne({ where: { barcode } });
        if (found) return found;
        if (profileCatalogId && color && lengthMm != null && storeId) {
            return resolveProfileStock(
                { profileCatalogId, color, lengthMm: parseFloat(lengthMm), storeId, barcode, zone, locationColumn, locationRow },
                { createIfMissing: true },
            );
        }
        return null;
    }
    return null;
}

// ============================================================
// Catalog (admin) -- profile master with photo
// ============================================================

const photosDir = path.resolve(process.cwd(), 'uploads/profile-catalog-photos');
fs.mkdirSync(photosDir, { recursive: true });
const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, photosDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
});
const allowedPhotoExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const photoMimeRegex = /^image\/(jpeg|png|gif|webp|bmp)$/;
const photoUpload = multer({
    storage: photoStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (photoMimeRegex.test(file.mimetype) && allowedPhotoExts.has(ext)) return cb(null, true);
        cb(new Error('Only valid image files are allowed'));
    },
    limits: { fileSize: 2 * 1024 * 1024 },
});

router.get('/catalog', requireAnyStockAccess, async (req, res) => {
    const search = String(req.query.search || '').trim();
    const { page, pageSize, offset } = paging(req);
    const where = search
        ? {
            [Op.or]: [
                { profileNo: { [Op.like]: `%${search}%` } },
                { profileName: { [Op.like]: `%${search}%` } },
                { barcode: { [Op.like]: `%${search}%` } },
            ],
        }
        : {};
    const { count, rows } = await MatWhProfileCatalog.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    // `items` is an alias of `catalog` for MasterData.tsx's generic
    // type-driven table (its own consumer, ProfileStoreCatalog.tsx, keeps
    // reading `catalog` -- both keys carry the same rows, harmless either
    // way).
    res.json({ success: true, catalog: rows, items: rows, total: count, page, pageSize });
});

router.post('/catalog', requireCatalog, async (req, res) => {
    try {
        const {
            profileNo, profileName, profileNameAr, details, detailsAr, barcode,
            category, subCategory, baseUnit, altUnit, conversionFactor, minQty,
        } = req.body;
        if (!profileNo?.trim() || !profileName?.trim()) {
            return res.status(400).json({ success: false, message: 'profileNo and profileName are required' });
        }
        const row = await MatWhProfileCatalog.create({
            profileNo: profileNo.trim(), profileName: profileName.trim(),
            profileNameAr: profileNameAr || null, details: details || null, detailsAr: detailsAr || null,
            barcode: barcode?.trim() || null,
            category: category || null, subCategory: subCategory || null,
            baseUnit: baseUnit || null, altUnit: altUnit || null,
            conversionFactor: conversionFactor ?? null, minQty: minQty ?? null,
        });
        res.status(201).json({ success: true, id: row.id });
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ success: false, message: 'That profile #/barcode already exists' });
        }
        console.error('❌ PROFILE CATALOG CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to create profile' });
    }
});

router.put('/catalog/:id', requireCatalog, async (req, res) => {
    try {
        const row = await MatWhProfileCatalog.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Profile not found' });
        const {
            profileNo, profileName, profileNameAr, details, detailsAr, barcode,
            category, subCategory, baseUnit, altUnit, conversionFactor, minQty, isActive,
        } = req.body;
        await row.update({
            profileNo: profileNo?.trim() ?? row.profileNo,
            profileName: profileName?.trim() ?? row.profileName,
            profileNameAr: profileNameAr !== undefined ? profileNameAr : row.profileNameAr,
            details: details !== undefined ? details : row.details,
            detailsAr: detailsAr !== undefined ? detailsAr : row.detailsAr,
            barcode: barcode !== undefined ? (barcode?.trim() || null) : row.barcode,
            category: category !== undefined ? category : row.category,
            subCategory: subCategory !== undefined ? subCategory : row.subCategory,
            baseUnit: baseUnit !== undefined ? baseUnit : row.baseUnit,
            altUnit: altUnit !== undefined ? altUnit : row.altUnit,
            conversionFactor: conversionFactor !== undefined ? conversionFactor : row.conversionFactor,
            minQty: minQty !== undefined ? minQty : row.minQty,
            isActive: isActive !== undefined ? isActive : row.isActive,
        });
        res.json({ success: true });
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ success: false, message: 'That profile #/barcode already exists' });
        }
        console.error('❌ PROFILE CATALOG UPDATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
});

router.delete('/catalog/:id', requireCatalog, async (req, res) => {
    try {
        const row = await MatWhProfileCatalog.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Profile not found' });
        if (row.photoUrl) {
            const p = path.join(photosDir, path.basename(row.photoUrl));
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        await row.destroy();
        res.json({ success: true });
    } catch (err) {
        console.error('❌ PROFILE CATALOG DELETE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to delete profile' });
    }
});

router.post('/catalog/:id/photo', requireCatalog, photoUpload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded' });
        const row = await MatWhProfileCatalog.findByPk(req.params.id);
        if (!row) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, message: 'Profile not found' });
        }
        const oldPhotoUrl = row.photoUrl;
        await row.update({ photoUrl: req.file.filename });
        if (oldPhotoUrl) {
            const oldPath = path.join(photosDir, path.basename(oldPhotoUrl));
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        res.json({ success: true, photoUrl: req.file.filename });
    } catch (err) {
        console.error('❌ PROFILE CATALOG PHOTO UPLOAD ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to upload photo' });
    }
});

// ============================================================
// Assemblies (admin)
// ============================================================

router.get('/assemblies', requireCatalog, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const { count, rows } = await MatWhProfileAssembly.findAndCountAll({ order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, assemblies: rows, total: count, page, pageSize });
});

router.post('/assemblies', requireCatalog, async (req, res) => {
    try {
        const { assemblyProfileNo, partProfileNo1, partProfileNo2, partProfileNo3, partProfileNo4, partProfileNo5 } = req.body;
        if (!assemblyProfileNo?.trim()) return res.status(400).json({ success: false, message: 'assemblyProfileNo is required' });
        const row = await MatWhProfileAssembly.create({
            assemblyProfileNo: assemblyProfileNo.trim(),
            partProfileNo1: partProfileNo1 || null, partProfileNo2: partProfileNo2 || null,
            partProfileNo3: partProfileNo3 || null, partProfileNo4: partProfileNo4 || null, partProfileNo5: partProfileNo5 || null,
        });
        res.status(201).json({ success: true, id: row.id });
    } catch (err) {
        console.error('❌ PROFILE ASSEMBLY CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to create assembly' });
    }
});

router.put('/assemblies/:id', requireCatalog, async (req, res) => {
    const row = await MatWhProfileAssembly.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Assembly not found' });
    const { assemblyProfileNo, partProfileNo1, partProfileNo2, partProfileNo3, partProfileNo4, partProfileNo5, isActive } = req.body;
    await row.update({
        assemblyProfileNo: assemblyProfileNo?.trim() ?? row.assemblyProfileNo,
        partProfileNo1: partProfileNo1 !== undefined ? partProfileNo1 : row.partProfileNo1,
        partProfileNo2: partProfileNo2 !== undefined ? partProfileNo2 : row.partProfileNo2,
        partProfileNo3: partProfileNo3 !== undefined ? partProfileNo3 : row.partProfileNo3,
        partProfileNo4: partProfileNo4 !== undefined ? partProfileNo4 : row.partProfileNo4,
        partProfileNo5: partProfileNo5 !== undefined ? partProfileNo5 : row.partProfileNo5,
        isActive: isActive !== undefined ? isActive : row.isActive,
    });
    res.json({ success: true });
});

router.delete('/assemblies/:id', requireCatalog, async (req, res) => {
    const row = await MatWhProfileAssembly.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Assembly not found' });
    await row.destroy();
    res.json({ success: true });
});

// ============================================================
// Stock (SKU/barcode registry, incl. location)
// ============================================================

router.get('/stock/barcode/:barcode', requireAnyStockAccess, async (req, res) => {
    const result = await findProfileStockByBarcode(String(req.params.barcode).trim(), req.query.storeId ? parseInt(req.query.storeId, 10) : null);
    if (!result) return res.status(404).json({ success: false, message: 'No item found for this barcode' });
    const balance = await getPhysicalBalance(result.stock.id);
    const available = await getAvailableToReserve(result.stock.id);
    res.json({ success: true, stock: result.stock, catalog: result.catalog, balance, available });
});

router.get('/stock', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.profileCatalogId) where.profileCatalogId = parseInt(req.query.profileCatalogId, 10);
    if (req.query.search) {
        where.barcode = { [Op.like]: `%${String(req.query.search).trim()}%` };
    }
    const { count, rows } = await MatWhProfileStock.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, stock: rows, total: count, page, pageSize });
});

// Create a new SKU/barcode combination directly (rather than implicitly via
// a receipt) -- lets a storekeeper pre-register a location before the first
// receipt ever arrives.
router.post('/stock', requireReceive, async (req, res) => {
    try {
        const { profileCatalogId, color, lengthMm, storeId, barcode, zone, locationColumn, locationRow } = req.body;
        if (!profileCatalogId || !color || lengthMm === undefined || lengthMm === null || !storeId || !barcode?.trim()) {
            return res.status(400).json({ success: false, message: 'profileCatalogId, color, lengthMm, storeId and barcode are required' });
        }
        const row = await MatWhProfileStock.create({
            profileCatalogId, color, lengthMm: parseFloat(lengthMm), storeId,
            barcode: barcode.trim(), zone: zone || null, locationColumn: locationColumn || null, locationRow: locationRow || null,
        });
        res.status(201).json({ success: true, id: row.id });
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ success: false, message: 'A barcode or profile/color/length/store combination already exists' });
        }
        console.error('❌ PROFILE STOCK CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to create stock entry' });
    }
});

// Location (zone/column/row) and barcode are the only fields a storekeeper should ever
// correct after the fact -- identity fields (profile/color/length/store)
// are excluded, same "identity keys stay fixed" convention Stock House used
// throughout (see routes/stockHouse.js's PUT /enter/:recordNo comment).
router.put('/stock/:id', requireReceive, async (req, res) => {
    try {
        const row = await MatWhProfileStock.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Stock entry not found' });
        const { zone, locationColumn, locationRow, barcode, isActive } = req.body;
        await row.update({
            zone: zone !== undefined ? zone : row.zone,
            locationColumn: locationColumn !== undefined ? locationColumn : row.locationColumn,
            locationRow: locationRow !== undefined ? locationRow : row.locationRow,
            barcode: barcode?.trim() || row.barcode,
            isActive: isActive !== undefined ? isActive : row.isActive,
        });
        res.json({ success: true });
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ success: false, message: 'That barcode is already in use' });
        }
        console.error('❌ PROFILE STOCK UPDATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to update stock entry' });
    }
});

// ============================================================
// Receipts (receive + QC)
// ============================================================

router.post('/receipts', requireReceive, async (req, res) => {
    try {
        const {
            supplier, projectNo, qtyReceived, qtyEvaluated, qtyLoss, qtyRejected, weight, unit,
            whouseOfficer, qcOfficer, qcTestNo, qcTestResult,
        } = req.body;
        const qty = parseFloat(qtyReceived);
        if (!Number.isFinite(qty) || qty <= 0) {
            return res.status(400).json({ success: false, message: 'A positive qtyReceived is required' });
        }
        const stock = await resolveStock(req.body);
        if (!stock) {
            return res.status(400).json({ success: false, message: 'No matching stock item -- supply a barcode, or profileCatalogId/color/lengthMm/storeId to register a new one' });
        }
        const row = await MatWhProfileReceipt.create({
            profileStockId: stock.id, storeId: stock.storeId,
            supplier: supplier || null, projectNo: projectNo || null,
            qtyReceived: qty,
            qtyEvaluated: qtyEvaluated != null ? parseFloat(qtyEvaluated) : null,
            qtyLoss: qtyLoss != null ? parseFloat(qtyLoss) : null,
            qtyRejected: qtyRejected != null ? parseFloat(qtyRejected) : null,
            weight: weight != null ? parseFloat(weight) : null,
            unit: unit || null,
            whouseOfficer: whouseOfficer || null, whouseDate: whouseOfficer ? new Date() : null,
            qcOfficer: qcOfficer || null, qcDate: qcOfficer ? new Date() : null,
            qcTestNo: qcTestNo || null, qcTestResult: qcTestResult || null, qcTestDate: qcTestResult ? new Date() : null,
            enteredBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE RECEIPT CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record receipt' });
    }
});

router.put('/receipts/:id', requireReceive, async (req, res) => {
    const row = await MatWhProfileReceipt.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Receipt not found' });
    const { supplier, whouseOfficer, qcOfficer, qcTestNo, qcTestResult } = req.body;
    await row.update({
        supplier: supplier !== undefined ? supplier : row.supplier,
        whouseOfficer: whouseOfficer !== undefined ? whouseOfficer : row.whouseOfficer,
        qcOfficer: qcOfficer !== undefined ? qcOfficer : row.qcOfficer,
        qcTestNo: qcTestNo !== undefined ? qcTestNo : row.qcTestNo,
        qcTestResult: qcTestResult !== undefined ? qcTestResult : row.qcTestResult,
    });
    res.json({ success: true });
});

router.get('/receipts', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.profileStockId) where.profileStockId = parseInt(req.query.profileStockId, 10);
    const { count, rows } = await MatWhProfileReceipt.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, receipts: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Reservations
// ============================================================

router.post('/reservations', requireReserve, async (req, res) => {
    try {
        const { projectNo, projectName, projectManager, qty, note } = req.body;
        const q = parseFloat(qty);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        if (!projectNo?.trim()) return res.status(400).json({ success: false, message: 'projectNo is required' });
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching stock item for this barcode' });

        const available = await getAvailableToReserve(stock.id);
        if (q > available) {
            return res.status(400).json({ success: false, message: `Only ${available} available to reserve` });
        }

        const row = await MatWhProfileReservation.create({
            profileStockId: stock.id, storeId: stock.storeId,
            projectNo: projectNo.trim(), projectName: projectName || null, projectManager: projectManager || null,
            qty: q, note: note || null, reservedBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE RESERVATION CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to create reservation' });
    }
});

router.put('/reservations/:id', requireReserve, async (req, res) => {
    const row = await MatWhProfileReservation.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Reservation not found' });
    const { note } = req.body;
    await row.update({ note: note !== undefined ? note : row.note });
    res.json({ success: true });
});

router.put('/reservations/:id/release', requireReserve, async (req, res) => {
    const row = await MatWhProfileReservation.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Reservation not found' });
    if (row.status === 'released') return res.status(409).json({ success: false, message: 'Already released' });
    await row.update({ status: 'released', releasedBy: req.user.userId, releasedAt: new Date() });
    res.json({ success: true });
});

router.get('/reservations', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.projectNo) where.projectNo = req.query.projectNo;
    if (req.query.status) where.status = req.query.status;
    const { count, rows } = await MatWhProfileReservation.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, reservations: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Shipments (issue to project)
// ============================================================

router.post('/shipments', requireIssue, async (req, res) => {
    try {
        const { projectNo, projectName, productionNo, worker, qty } = req.body;
        const q = parseFloat(qty);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        if (!projectNo?.trim()) return res.status(400).json({ success: false, message: 'projectNo is required' });
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching stock item for this barcode' });

        const balance = await getPhysicalBalance(stock.id);
        if (q > balance) return res.status(400).json({ success: false, message: `Only ${balance} on hand` });

        const row = await MatWhProfileShipment.create({
            profileStockId: stock.id, storeId: stock.storeId,
            projectNo: projectNo.trim(), projectName: projectName || null, productionNo: productionNo || null,
            worker: worker || null, qty: q, shippedBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE SHIPMENT CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record shipment' });
    }
});

router.put('/shipments/:id', requireIssue, async (req, res) => {
    const row = await MatWhProfileShipment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Shipment not found' });
    const { worker, productionNo } = req.body;
    await row.update({
        worker: worker !== undefined ? worker : row.worker,
        productionNo: productionNo !== undefined ? productionNo : row.productionNo,
    });
    res.json({ success: true });
});

router.get('/shipments', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.projectNo) where.projectNo = req.query.projectNo;
    const { count, rows } = await MatWhProfileShipment.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, shipments: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Returns
// ============================================================

router.post('/returns', requireIssue, async (req, res) => {
    try {
        const { projectNo, projectName, productionNo, worker, qty } = req.body;
        const q = parseFloat(qty);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching stock item for this barcode' });

        const row = await MatWhProfileReturn.create({
            profileStockId: stock.id, storeId: stock.storeId,
            projectNo: projectNo || null, projectName: projectName || null, productionNo: productionNo || null,
            worker: worker || null, qty: q, returnedBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE RETURN CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record return' });
    }
});

router.put('/returns/:id', requireIssue, async (req, res) => {
    const row = await MatWhProfileReturn.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Return not found' });
    const { worker, productionNo } = req.body;
    await row.update({
        worker: worker !== undefined ? worker : row.worker,
        productionNo: productionNo !== undefined ? productionNo : row.productionNo,
    });
    res.json({ success: true });
});

router.get('/returns', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    const { count, rows } = await MatWhProfileReturn.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, returns: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Coating batches (send mill-finish out, receive coated stock back)
// ============================================================

router.post('/coating-batches', requireCoating, async (req, res) => {
    try {
        const {
            projectNo, projectName, projectManager, coatingCompany, targetColor,
            requestNo, stockOfficer, stockManager, qty, reservationId,
        } = req.body;
        const q = parseFloat(qty);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        if (!projectNo?.trim()) return res.status(400).json({ success: false, message: 'projectNo is required' });
        if (!targetColor?.trim()) return res.status(400).json({ success: false, message: 'targetColor is required' });
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching mill-finish stock item for this barcode' });

        const balance = await getPhysicalBalance(stock.id);
        if (q > balance) return res.status(400).json({ success: false, message: `Only ${balance} on hand` });

        const row = await MatWhProfileCoatingBatch.create({
            profileStockId: stock.id, storeId: stock.storeId,
            projectNo: projectNo.trim(), projectName: projectName || null, projectManager: projectManager || null,
            coatingCompany: coatingCompany || null, targetColor: targetColor.trim(), requestNo: requestNo || null,
            stockOfficer: stockOfficer || null, stockManager: stockManager || null,
            qtySent: q, dateSend: new Date(), reservationId: reservationId || null, sentBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE COATING BATCH CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record coating send-out' });
    }
});

router.put('/coating-batches/:id', requireCoating, async (req, res) => {
    const row = await MatWhProfileCoatingBatch.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Coating batch not found' });
    const { coatingCompany, stockOfficer, stockManager, requestNo } = req.body;
    await row.update({
        coatingCompany: coatingCompany !== undefined ? coatingCompany : row.coatingCompany,
        stockOfficer: stockOfficer !== undefined ? stockOfficer : row.stockOfficer,
        stockManager: stockManager !== undefined ? stockManager : row.stockManager,
        requestNo: requestNo !== undefined ? requestNo : row.requestNo,
    });
    res.json({ success: true });
});

// Receiving coated material back: closes out the batch's qtyReceived and
// creates a genuinely new profileStock row (the coated combination, keyed
// by targetColor) plus a receipt row crediting it -- mirrors Stock House's
// POST /mix/receive, which likewise never credits the original mill code.
router.post('/coating-batches/:id/receive', requireCoating, async (req, res) => {
    try {
        const batch = await MatWhProfileCoatingBatch.findByPk(req.params.id);
        if (!batch) return res.status(404).json({ success: false, message: 'Coating batch not found' });

        const qty = parseFloat(req.body.qty);
        if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        const remaining = batch.qtySent - batch.qtyReceived;
        if (qty > remaining) {
            return res.status(400).json({ success: false, message: `Only ${remaining} unit(s) remaining to receive` });
        }

        const millStock = await MatWhProfileStock.findByPk(batch.profileStockId);
        const { barcode, color1 } = req.body;
        let coatedStock = await MatWhProfileStock.findOne({
            where: { profileCatalogId: millStock.profileCatalogId, color: batch.targetColor, lengthMm: millStock.lengthMm, storeId: millStock.storeId },
        });
        if (!coatedStock) {
            if (!barcode?.trim()) {
                return res.status(400).json({ success: false, message: 'barcode is required to register the coated combination for the first time' });
            }
            coatedStock = await MatWhProfileStock.create({
                profileCatalogId: millStock.profileCatalogId, color: batch.targetColor, lengthMm: millStock.lengthMm,
                storeId: millStock.storeId, barcode: barcode.trim(),
            });
        }

        const receipt = await MatWhProfileReceipt.create({
            profileStockId: coatedStock.id, storeId: coatedStock.storeId,
            projectNo: batch.projectNo, qtyReceived: qty, sourceCoatingBatchId: batch.id, enteredBy: req.user.userId,
        });

        const newQtyReceived = batch.qtyReceived + qty;
        await batch.update({
            qtyReceived: newQtyReceived,
            receivedColor1: color1 || batch.receivedColor1,
            dateLastReceive: new Date(),
            status: newQtyReceived >= batch.qtySent ? 'received' : 'partially_received',
        });

        res.status(201).json({ success: true, receiptId: receipt.id, coatedStockId: coatedStock.id, coatedBarcode: coatedStock.barcode });
    } catch (err) {
        console.error('❌ PROFILE COATING RECEIVE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record coating receipt' });
    }
});

router.get('/coating-batches', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.status) where.status = req.query.status;
    if (req.query.outstanding === 'true') where.status = { [Op.ne]: 'received' };
    const { count, rows } = await MatWhProfileCoatingBatch.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, batches: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Transfers (internal store IN/OUT movement)
// ============================================================

router.post('/transfers', requireTransfer, async (req, res) => {
    try {
        const { direction, projectNo, projectName, projectManager, qty, stockOfficer, stockManager } = req.body;
        const dir = String(direction || '').toLowerCase();
        if (dir !== 'in' && dir !== 'out') return res.status(400).json({ success: false, message: "direction must be 'in' or 'out'" });
        const q = parseFloat(qty);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qty is required' });
        if (!projectNo?.trim()) return res.status(400).json({ success: false, message: 'projectNo is required' });
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching stock item -- supply barcode, or profileCatalogId/color/lengthMm/storeId to register a new one' });

        if (dir === 'out') {
            const balance = await getPhysicalBalance(stock.id);
            if (q > balance) return res.status(400).json({ success: false, message: `Only ${balance} on hand` });
        }

        const row = await MatWhProfileTransfer.create({
            profileStockId: stock.id, storeId: stock.storeId, direction: dir,
            projectNo: projectNo.trim(), projectName: projectName || null, projectManager: projectManager || null,
            qty: q, stockOfficer: stockOfficer || null, stockManager: stockManager || null, transferredBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, stockId: stock.id, barcode: stock.barcode });
    } catch (err) {
        console.error('❌ PROFILE TRANSFER CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to create transfer' });
    }
});

router.get('/transfers', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.projectNo) where.projectNo = req.query.projectNo;
    const { count, rows } = await MatWhProfileTransfer.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, transfers: await attachBarcodes(rows), total: count, page, pageSize });
});

// ============================================================
// Feasibility checks (production availability check, non-moving)
// ============================================================

router.post('/feasibility-checks', requireReserve, async (req, res) => {
    try {
        const { projectNo, productionNo, qtyRequested, weight } = req.body;
        const q = parseFloat(qtyRequested);
        if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ success: false, message: 'A positive qtyRequested is required' });
        if (!projectNo?.trim() || !productionNo?.trim()) {
            return res.status(400).json({ success: false, message: 'projectNo and productionNo are required' });
        }
        const stock = await resolveStock(req.body);
        if (!stock) return res.status(400).json({ success: false, message: 'No matching stock item for this barcode' });

        const qtyAvailableAtCheck = await getPhysicalBalance(stock.id);
        const row = await MatWhProfileFeasibilityCheck.create({
            profileStockId: stock.id, storeId: stock.storeId,
            projectNo: projectNo.trim(), productionNo: productionNo.trim(),
            qtyRequested: q, qtyAvailableAtCheck, feasible: qtyAvailableAtCheck >= q,
            weight: weight != null ? parseFloat(weight) : null, checkedBy: req.user.userId,
        });
        res.status(201).json({ success: true, id: row.id, feasible: row.feasible, qtyAvailableAtCheck });
    } catch (err) {
        console.error('❌ PROFILE FEASIBILITY CHECK CREATE ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to record feasibility check' });
    }
});

router.get('/feasibility-checks', requireAnyStockAccess, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.projectNo) where.projectNo = req.query.projectNo;
    const { count, rows } = await MatWhProfileFeasibilityCheck.findAndCountAll({ where, order: [['id', 'DESC']], limit: pageSize, offset });
    res.json({ success: true, checks: rows, total: count, page, pageSize });
});

// ============================================================
// Reports: stock levels, item card (history), remaining-per-project
// ============================================================

router.get('/stock-levels', requireReports, async (req, res) => {
    const { page, pageSize, offset } = paging(req);
    const where = {};
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    if (req.query.profileCatalogId) where.profileCatalogId = parseInt(req.query.profileCatalogId, 10);
    const { count, rows } = await MatWhProfileStock.findAndCountAll({ where, order: [['id', 'ASC']], limit: pageSize, offset });
    const levels = await Promise.all(rows.map(async (s) => ({
        stock: s, balance: await getPhysicalBalance(s.id), available: await getAvailableToReserve(s.id),
    })));
    res.json({ success: true, levels, total: count, page, pageSize });
});

// Full transaction history for one barcode, running balance included --
// mirrors Stock House's GET /card/:computerNo.
router.get('/card/:barcode', requireAnyStockAccess, async (req, res) => {
    const stock = await MatWhProfileStock.findOne({ where: { barcode: String(req.params.barcode).trim() } });
    if (!stock) return res.status(404).json({ success: false, message: 'No item found for this barcode' });

    const [receipts, shipments, returns, coatingSent, transfersIn, transfersOut] = await Promise.all([
        MatWhProfileReceipt.findAll({ where: { profileStockId: stock.id }, order: [['createdAt', 'ASC']] }),
        MatWhProfileShipment.findAll({ where: { profileStockId: stock.id }, order: [['createdAt', 'ASC']] }),
        MatWhProfileReturn.findAll({ where: { profileStockId: stock.id }, order: [['createdAt', 'ASC']] }),
        MatWhProfileCoatingBatch.findAll({ where: { profileStockId: stock.id }, order: [['createdAt', 'ASC']] }),
        MatWhProfileTransfer.findAll({ where: { profileStockId: stock.id, direction: 'in' }, order: [['createdAt', 'ASC']] }),
        MatWhProfileTransfer.findAll({ where: { profileStockId: stock.id, direction: 'out' }, order: [['createdAt', 'ASC']] }),
    ]);

    const events = [
        ...receipts.map((r) => ({ date: r.createdAt, type: 'IN', qty: r.qtyReceived, ref: r.projectNo })),
        ...shipments.map((r) => ({ date: r.createdAt, type: 'OUT', qty: -r.qty, ref: r.projectNo })),
        ...returns.map((r) => ({ date: r.createdAt, type: 'RETURN', qty: r.qty, ref: r.projectNo })),
        ...coatingSent.map((r) => ({ date: r.dateSend || r.createdAt, type: 'COATING_OUT', qty: -r.qtySent, ref: r.projectNo })),
        ...transfersIn.map((r) => ({ date: r.createdAt, type: 'TRANSFER_IN', qty: r.qty, ref: r.projectNo })),
        ...transfersOut.map((r) => ({ date: r.createdAt, type: 'TRANSFER_OUT', qty: -r.qty, ref: r.projectNo })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let running = 0;
    const transactions = events.map((e) => { running += e.qty; return { ...e, balance: running }; });

    res.json({ success: true, stock, transactions });
});

// Outstanding balance per project: what's reserved but not yet shipped
// (net of returns) -- simplified relative to Stock House's GET /remaining
// since this module starts with no history and no legacy
// ReReservation2-style cross-project transfer ledger to reconcile against.
router.get('/remaining', requireReports, async (req, res) => {
    const where = { status: 'active' };
    if (req.query.projectNo) where.projectNo = req.query.projectNo;
    if (req.query.storeId) where.storeId = parseInt(req.query.storeId, 10);
    const reservations = await MatWhProfileReservation.findAll({ where });

    const byKey = new Map();
    for (const r of reservations) {
        const key = `${r.projectNo}|${r.profileStockId}`;
        if (!byKey.has(key)) byKey.set(key, { projectNo: r.projectNo, projectName: r.projectName, profileStockId: r.profileStockId, storeId: r.storeId, reserved: 0 });
        byKey.get(key).reserved += r.qty;
    }

    const items = [];
    for (const entry of byKey.values()) {
        const shipped = await MatWhProfileShipment.sum('qty', { where: { profileStockId: entry.profileStockId, projectNo: entry.projectNo } }) || 0;
        const returned = await MatWhProfileReturn.sum('qty', { where: { profileStockId: entry.profileStockId, projectNo: entry.projectNo } }) || 0;
        const remaining = entry.reserved - shipped + returned;
        if (remaining !== 0) items.push({ ...entry, shipped, returned, remaining });
    }

    res.json({ success: true, items });
});

export default router;
