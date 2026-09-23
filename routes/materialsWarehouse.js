// backend/routes/materialsWarehouse.js
// WH.1: master-data CRUD for the new Materials Warehouse module (stores,
// items, user-store assignments, QC categories, vendor fields) -- see the
// Alpha Warehouse Analysis report §10. Purchasing/warehouse-operations/
// costing endpoints (WH.2-WH.4) are not built yet.
//
// Every endpoint here requires MATERIALS_WAREHOUSE_MASTER_DATA -- both
// reads and writes, unlike lookups.js's broader view/narrow edit split.
// That split exists there because other modules need lookup dropdowns;
// nothing outside this module needs to read matWh* master data yet, and
// WH.2/WH.3's own routes will get their own permission keys when they're
// built, not reuse this one.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Op, QueryTypes } from 'sequelize';
import { authenticateToken } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhUserStoreAssignment } from '../models/MatWhUserStoreAssignment.js';
import { MatWhQcCategory } from '../models/MatWhQcCategory.js';
import { MatWhCategory } from '../models/MatWhCategory.js';
import { MatWhSubCategory } from '../models/MatWhSubCategory.js';
import { MatWhUnit } from '../models/MatWhUnit.js';
import { Vendor } from '../models/Vendor.js';
import { MatWhItemStore } from '../models/MatWhItemStore.js';

const router = express.Router();
router.use(authenticateToken, requirePermission(PERMISSIONS.MATERIALS_WAREHOUSE_MASTER_DATA));

// Item photo upload -- same multer/filename/cleanup pattern as
// materialsWarehouseProfileStore.js's profile-catalog photo endpoint, kept
// in its own uploads dir since matWhItems and matWhProfileCatalog are
// separate tables/catalogs.
const itemPhotosDir = path.resolve(process.cwd(), 'uploads/item-photos');
fs.mkdirSync(itemPhotosDir, { recursive: true });
const itemPhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, itemPhotosDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
});
const allowedPhotoExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const photoMimeRegex = /^image\/(jpeg|png|gif|webp|bmp)$/;
const itemPhotoUpload = multer({
    storage: itemPhotoStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (photoMimeRegex.test(file.mimetype) && allowedPhotoExts.has(ext)) return cb(null, true);
        cb(new Error('Only valid image files are allowed'));
    },
    limits: { fileSize: 2 * 1024 * 1024 },
});

router.post('/items/:id/photo', itemPhotoUpload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No image uploaded' });
        const row = await MatWhItem.findByPk(req.params.id);
        if (!row) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ success: false, message: 'Item not found' });
        }
        const oldPhotoUrl = row.photoUrl;
        await row.update({ photoUrl: req.file.filename });
        if (oldPhotoUrl) {
            const oldPath = path.join(itemPhotosDir, path.basename(oldPhotoUrl));
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        res.json({ success: true, photoUrl: req.file.filename });
    } catch (err) {
        console.error('❌ ITEM PHOTO UPLOAD ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to upload photo' });
    }
});

// GET /catalog -- paginated Items listing for Master Data's unified
// "Items" view. Used to be a real SQL UNION ALL against matWhProfileCatalog
// too (aluminum profiles had their own table) -- that table's contents were
// migrated into matWhItems directly back on 2026-09-15 (see the
// materials-warehouse-module memory's "profiles and items merged into ONE
// table" entry) and matWhProfileCatalog has been empty ever since, so the
// UNION was contributing zero rows. Simplified to a plain matWhItems query;
// `_kind` is now always `'item'` rather than something to genuinely
// distinguish (kept on the response so the frontend's existing
// `_kind ?? 'item'` handling and edit/delete/photo routing needs no
// changes) -- see MasterData.tsx's CatalogKind type.
router.get('/catalog', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
    const search = String(req.query.search || '').trim();
    const searchLike = `%${search}%`;

    const where = search
        ? `WHERE itemCode LIKE :searchLike OR itemName LIKE :searchLike OR itemNameAr LIKE :searchLike OR barcode LIKE :searchLike`
        : '';

    const baseSql = `
        SELECT 'item' AS _kind, id,
               itemCode AS code, itemName AS name, itemNameAr AS nameAr,
               barcode, category, subCategory, baseUnit, altUnit, conversionFactor,
               minQty, maxQty, reorderQty, preferredVendorId, allowPurchase, allowIssue,
               details, detailsAr, photoUrl, isActive
        FROM matWhItems ${where}
    `;

    const replacements = { searchLike, limit: pageSize, offset: (page - 1) * pageSize };
    const [rows, countRows] = await Promise.all([
        sequelizeUtf8.query(`${baseSql} ORDER BY code LIMIT :limit OFFSET :offset`, {
            replacements, type: QueryTypes.SELECT,
        }),
        sequelizeUtf8.query(`SELECT COUNT(*) AS total FROM matWhItems ${where}`, {
            replacements, type: QueryTypes.SELECT,
        }),
    ]);

    res.json({ total: Number(countRows[0].total), items: rows });
});

// Generic list/create/update/delete for a given model -- 5 tables, same
// shape of endpoint, same pattern lookups.js already uses for a bigger
// registry. Kept as one small helper here rather than a full registry +
// router.param('type', ...) like lookups.js, since these 5 aren't a fixed
// <table>Id/<table>Name shape and each has its own real field list.
function crudRoutes(path, model, pkField, searchFields = []) {
    router.get(`/${path}`, async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
        const search = String(req.query.search || '').trim();
        const where = search && searchFields.length
            ? { [Op.or]: searchFields.map((f) => ({ [f]: { [Op.like]: `%${search}%` } })) }
            : undefined;
        const { count, rows } = await model.findAndCountAll({
            where,
            limit: pageSize,
            offset: (page - 1) * pageSize,
            order: [[pkField, 'ASC']],
        });
        res.json({ total: count, items: rows });
    });

    router.get(`/${path}/:id`, async (req, res) => {
        const row = await model.findByPk(req.params.id);
        if (!row) return res.status(404).json({ message: 'Not found' });
        res.json(row);
    });

    router.post(`/${path}`, async (req, res) => {
        const attrs = Object.keys(model.getAttributes()).filter((a) => a !== pkField);
        const values = {};
        for (const a of attrs) if (req.body[a] !== undefined) values[a] = req.body[a];

        try {
            const row = await model.create(values);
            res.status(201).json(row);
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                return res.status(409).json({ message: 'A row with that value already exists' });
            }
            console.error(`Error creating ${path} row:`, err);
            res.status(500).json({ message: 'Failed to create row' });
        }
    });

    router.patch(`/${path}/:id`, async (req, res) => {
        const row = await model.findByPk(req.params.id);
        if (!row) return res.status(404).json({ message: 'Not found' });

        const attrs = Object.keys(model.getAttributes()).filter((a) => a !== pkField);
        const updates = {};
        for (const a of attrs) if (req.body[a] !== undefined) updates[a] = req.body[a];

        try {
            await row.update(updates);
            res.json(row);
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                return res.status(409).json({ message: 'A row with that value already exists' });
            }
            console.error(`Error updating ${path} row:`, err);
            res.status(500).json({ message: 'Failed to update row' });
        }
    });

    router.delete(`/${path}/:id`, async (req, res) => {
        const row = await model.findByPk(req.params.id);
        if (!row) return res.status(404).json({ message: 'Not found' });
        await row.destroy();
        res.json({ message: 'deleted' });
    });
}

crudRoutes('stores', MatWhStore, 'id', ['storeCode', 'storeName', 'storeNameAr']);
crudRoutes('items', MatWhItem, 'id', ['itemCode', 'itemName', 'itemNameAr', 'barcode']);
crudRoutes('user-store-assignments', MatWhUserStoreAssignment, 'id');
crudRoutes('qc-categories', MatWhQcCategory, 'id', ['categoryCode', 'categoryName', 'categoryNameAr']);
crudRoutes('categories', MatWhCategory, 'id', ['categoryCode', 'categoryName', 'categoryNameAr']);
crudRoutes('sub-categories', MatWhSubCategory, 'id', ['subCategoryCode', 'subCategoryName', 'subCategoryNameAr']);
crudRoutes('units', MatWhUnit, 'id', ['unitCode', 'unitName', 'unitNameAr']);
// vendors: PK is vendorId, not id -- the existing legacy table's own
// column name, kept as-is rather than renamed.
crudRoutes('vendors', Vendor, 'vendorId', ['vendorName', 'vendorDesc']);

// Which real store(s) an item lives in (MatWhItemStore.js) -- a plain
// many-to-many, managed here as "replace the whole set for this item" in
// one call rather than individual add/remove endpoints, since the edit
// form's own UI is a multi-select checked against the full store list.
router.get('/items/:id/stores', async (req, res) => {
    const item = await MatWhItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const rows = await MatWhItemStore.findAll({ where: { itemId: item.id } });
    res.json({
        storeIds: rows.map((r) => r.storeId),
        // Per-store general location (WH gap #9) -- keyed by storeId so the
        // frontend can seed its per-row inputs without a second round trip.
        stores: rows.map((r) => ({
            storeId: r.storeId, zone: r.zone, locationColumn: r.locationColumn, locationRow: r.locationRow,
        })),
    });
});

// Replace-the-whole-set semantics for MEMBERSHIP (which stores this item is
// in), but a real diff underneath -- NOT the old destroy-then-recreate.
// That would have silently wiped every store's zone/locationColumn/
// locationRow on every save, even a single unrelated checkbox toggle,
// once this route started carrying location data too. Only rows for
// deselected stores are destroyed (their location goes with them, by
// direct decision -- unchecking a store means "not kept there" and its
// location note stops meaning anything); only rows for newly-selected
// stores are created; a store that stays checked is updated in place
// (picks up any location edit) rather than being touched at all.
router.put('/items/:id/stores', async (req, res) => {
    const item = await MatWhItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const incoming = Array.isArray(req.body?.stores) ? req.body.stores : [];
    const submitted = new Map(
        incoming
            .map((s) => ({
                storeId: Number(s?.storeId),
                zone: s?.zone ? String(s.zone).trim() || null : null,
                locationColumn: s?.locationColumn ? String(s.locationColumn).trim() || null : null,
                locationRow: s?.locationRow ? String(s.locationRow).trim() || null : null,
            }))
            .filter((s) => s.storeId)
            .map((s) => [s.storeId, s]),
    );

    const existing = await MatWhItemStore.findAll({ where: { itemId: item.id } });
    const existingByStoreId = new Map(existing.map((r) => [r.storeId, r]));

    const toRemove = existing.filter((r) => !submitted.has(r.storeId));
    if (toRemove.length > 0) {
        await MatWhItemStore.destroy({ where: { itemId: item.id, storeId: toRemove.map((r) => r.storeId) } });
    }
    for (const [storeId, s] of submitted) {
        const row = existingByStoreId.get(storeId);
        if (row) {
            await row.update({ zone: s.zone, locationColumn: s.locationColumn, locationRow: s.locationRow });
        } else {
            await MatWhItemStore.create({ itemId: item.id, storeId, zone: s.zone, locationColumn: s.locationColumn, locationRow: s.locationRow });
        }
    }

    const rows = await MatWhItemStore.findAll({ where: { itemId: item.id } });
    res.json({
        storeIds: rows.map((r) => r.storeId),
        stores: rows.map((r) => ({
            storeId: r.storeId, zone: r.zone, locationColumn: r.locationColumn, locationRow: r.locationRow,
        })),
    });
});

export default router;
