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

// GET /catalog -- combined, paginated Item + Aluminum Profile listing for
// Master Data's unified "Items" view (per explicit direction: one place to
// browse/add either kind, not two separate tabs). A real SQL UNION ALL
// (both tables live on this same sequelizeUtf8 connection) rather than a
// client-side merge of two separately-paginated fetches -- that would give
// wrong page boundaries the moment the combined row count crosses a single
// page size. `kind` tags each row so the frontend knows which real
// endpoint (`/items` vs `/profile-store/catalog`) owns it for edit/delete/
// photo actions.
//
// Deliberately gated by this router's own MATERIALS_WAREHOUSE_MASTER_DATA
// permission only, same as every other endpoint here -- NOT also requiring
// MATERIALS_WAREHOUSE_PROFILE_CATALOG. That means anyone with Master Data
// access now sees profile rows here too, even without Profile Catalog
// access on its own. Accepted deliberately (explicit direction: combine
// them), but worth remembering if that boundary matters later.
router.get('/catalog', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 25));
    const search = String(req.query.search || '').trim();
    const searchLike = `%${search}%`;

    const itemWhere = search
        ? `WHERE itemCode LIKE :searchLike OR itemName LIKE :searchLike OR itemNameAr LIKE :searchLike OR barcode LIKE :searchLike`
        : '';
    const profileWhere = search
        ? `WHERE profileNo LIKE :searchLike OR profileName LIKE :searchLike OR profileNameAr LIKE :searchLike OR barcode LIKE :searchLike`
        : '';

    // matWhItems and matWhProfileCatalog ended up on different text
    // collations (utf8mb4_unicode_ci vs utf8mb4_general_ci -- the item
    // table's barcode/details/etc. columns were added later via a plain
    // ALTER TABLE that inherited the connection's default rather than the
    // original table's collation). MySQL refuses to UNION mismatched
    // collations, so every text column is explicitly coerced to one common
    // collation here rather than altering either table to fix the root
    // cause.
    const C = 'COLLATE utf8mb4_general_ci';
    const unionSql = `
        SELECT 'item' AS _kind, id,
               itemCode ${C} AS code, itemName ${C} AS name, itemNameAr ${C} AS nameAr,
               barcode ${C} AS barcode, category ${C} AS category, subCategory ${C} AS subCategory,
               baseUnit ${C} AS baseUnit, altUnit ${C} AS altUnit, conversionFactor,
               minQty, maxQty, reorderQty, preferredVendorId, allowPurchase, allowIssue,
               details ${C} AS details, detailsAr ${C} AS detailsAr,
               photoUrl ${C} AS photoUrl, isActive
        FROM matWhItems ${itemWhere}
        UNION ALL
        SELECT 'profile' AS _kind, id,
               profileNo ${C} AS code, profileName ${C} AS name, profileNameAr ${C} AS nameAr,
               barcode ${C} AS barcode, category ${C} AS category, subCategory ${C} AS subCategory,
               baseUnit ${C} AS baseUnit, altUnit ${C} AS altUnit, conversionFactor,
               minQty, NULL AS maxQty, NULL AS reorderQty, NULL AS preferredVendorId,
               NULL AS allowPurchase, NULL AS allowIssue,
               details ${C} AS details, detailsAr ${C} AS detailsAr,
               photoUrl ${C} AS photoUrl, isActive
        FROM matWhProfileCatalog ${profileWhere}
    `;

    const replacements = { searchLike, limit: pageSize, offset: (page - 1) * pageSize };
    const [rows, countRows] = await Promise.all([
        sequelizeUtf8.query(`${unionSql} ORDER BY _kind, code LIMIT :limit OFFSET :offset`, {
            replacements, type: QueryTypes.SELECT,
        }),
        sequelizeUtf8.query(`SELECT COUNT(*) AS total FROM (${unionSql}) AS combined`, {
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
    res.json({ storeIds: rows.map((r) => r.storeId) });
});

router.put('/items/:id/stores', async (req, res) => {
    const item = await MatWhItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const storeIds = Array.isArray(req.body?.storeIds) ? req.body.storeIds.map(Number).filter(Boolean) : [];
    await MatWhItemStore.destroy({ where: { itemId: item.id } });
    for (const storeId of storeIds) {
        await MatWhItemStore.create({ itemId: item.id, storeId });
    }
    res.json({ storeIds });
});

export default router;
