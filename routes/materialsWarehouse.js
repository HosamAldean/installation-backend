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
import { User } from '../models/User.js';
import { MatWhUserVendorAssignment } from '../models/MatWhUserVendorAssignment.js';
import { MatWhQcCategory } from '../models/MatWhQcCategory.js';
import { MatWhCategory } from '../models/MatWhCategory.js';
import { MatWhSubCategory } from '../models/MatWhSubCategory.js';
import { MatWhUnit } from '../models/MatWhUnit.js';
import { Vendor } from '../models/Vendor.js';
import { MatWhItemStore } from '../models/MatWhItemStore.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { normalizeRequestKey, runOnceWithKey } from '../services/matWhRequestKeys.js';
import { AdminActionAudit } from '../models/AdminActionAudit.js';

const router = express.Router();
// This router is mounted first on /api/materials-warehouse, which every
// other warehouse router shares -- so a plain router.use guard ran on ALL
// of their requests too and 403'd anyone without .master_data (found
// 2026-10-22 testing the production role). Requests for paths this router
// doesn't serve skip straight to the next router.
const OWN_FIRST_SEGMENTS = new Set([
    'items', 'catalog', 'stores', 'user-vendor-assignments', 'store-access',
    'qc-categories', 'categories', 'sub-categories', 'units', 'vendors',
]);
router.use((req, res, next) => (OWN_FIRST_SEGMENTS.has(req.path.split('/')[1]) ? next() : next('router')));
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
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
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
            // Optional per-tap key (mobile Add Item, see
            // services/matWhRequestKeys.js): a replay answers with the row
            // the first request created instead of a duplicate-code 409.
            const { result: row, replay, refId } = await runOnceWithKey(
                normalizeRequestKey(req.body.requestKey), { action: `create_${path}`.slice(0, 40), userId: req.user?.userId },
                () => model.create(values),
            );
            if (replay) {
                const earlier = refId ? await model.findByPk(refId) : null;
                return res.json(earlier ? { ...earlier.toJSON(), alreadyApplied: true } : { alreadyApplied: true });
            }
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
crudRoutes('user-vendor-assignments', MatWhUserVendorAssignment, 'id');

// Store access (see services/matWhStoreAccess.js). Deliberately NOT a
// generic crudRoutes table: master_data is held by the storekeepers being
// scoped, and since "no rows = every store", letting them edit this table
// would let anyone un-scope themselves by deleting their own rows. Admin
// only, both read and write.
function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Only an admin can manage store access' });
    next();
}

// Every non-admin user whose role holds any Materials Warehouse permission,
// plus anyone who already has an assignment row, with their store ids.
router.get('/store-access', requireAdmin, async (req, res) => {
    const grants = await sequelizeUtf8.query(
        "SELECT DISTINCT role FROM PermissionGrants WHERE permissionKey LIKE 'materials_warehouse.%'",
        { type: QueryTypes.SELECT },
    );
    const assignments = await MatWhUserStoreAssignment.findAll();
    const assignedUserIds = [...new Set(assignments.map((a) => a.userId))];
    const users = await User.findAll({
        where: {
            role: { [Op.ne]: 'admin' },
            [Op.or]: [
                { role: grants.map((g) => g.role) },
                ...(assignedUserIds.length ? [{ userId: assignedUserIds }] : []),
            ],
        },
        attributes: ['userId', 'username', 'firstName', 'lastName', 'role'],
        order: [['role', 'ASC'], ['username', 'ASC']],
    });
    const storeIdsByUser = new Map();
    for (const a of assignments) {
        if (!storeIdsByUser.has(a.userId)) storeIdsByUser.set(a.userId, []);
        storeIdsByUser.get(a.userId).push(a.storeId);
    }
    res.json({
        items: users.map((u) => ({
            userId: u.userId, username: u.username, role: u.role,
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
            storeIds: storeIdsByUser.get(u.userId) || [],
        })),
    });
});

// Admin audit log entry (Audit Log -> Admin Actions) for a store-access
// change. Fire-and-forget like the other AdminActionAudit writers: a
// logging failure never undoes the change. The readable before/after goes
// in entityLabel (that page shows the label, not the changes JSON).
async function logStoreAccessChange(req, user, before, after) {
    try {
        if (before.join(",") === after.join(",")) return;
        const stores = await MatWhStore.findAll({ where: { id: [...before, ...after] }, attributes: ["id", "storeCode"] });
        const codeById = new Map(stores.map((s) => [s.id, s.storeCode]));
        const label = (ids) => (ids.length ? ids.map((id) => codeById.get(id) ?? id).join(", ") : "all stores");
        await AdminActionAudit.create({
            module: "matwh_store_access",
            entityType: "user",
            entityId: String(user.userId),
            entityLabel: `${user.username}: ${label(before)} -> ${label(after)}`.slice(0, 255),
            action: "updated",
            changes: JSON.stringify({ before, after }),
            performedByUserId: req.user?.userId ?? null,
        });
    } catch (err) {
        console.error("❌ Failed to record store access audit:", err);
    }
}

// Replace one user's whole store set; an empty list means every store
// again (the default).
router.put('/store-access/:userId', requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    const storeIds = [...new Set((req.body?.storeIds || []).map(Number))];
    if (storeIds.some((id) => !Number.isInteger(id))) return res.status(400).json({ message: 'storeIds must be store ids' });
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (storeIds.length) {
        const found = await MatWhStore.count({ where: { id: storeIds } });
        if (found !== storeIds.length) return res.status(400).json({ message: 'Unknown store id in storeIds' });
    }
    const before = (await MatWhUserStoreAssignment.findAll({ where: { userId } })).map((a) => a.storeId).sort((a, b) => a - b);
    const t = await sequelizeUtf8.transaction();
    try {
        await MatWhUserStoreAssignment.destroy({ where: { userId }, transaction: t });
        if (storeIds.length) {
            await MatWhUserStoreAssignment.bulkCreate(storeIds.map((storeId) => ({ userId, storeId })), { transaction: t });
        }
        await t.commit();
        logStoreAccessChange(req, user, before, [...storeIds].sort((a, b) => a - b));
        res.json({ userId, storeIds });
    } catch (err) {
        await t.rollback();
        console.error('Error saving store access:', err);
        res.status(500).json({ message: 'Failed to save store access' });
    }
});
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

// ============================================================
// Item variants (matWhItemVariants) -- one real, physically-barcoded SKU
// per color+length combination of a profile item. See MatWhItemVariant.js's
// own header comment for why this is additive alongside matWhItems, not a
// redesign of it. Only expected to matter for category='ALM' items, but
// not enforced at the route level -- no harm in a plain item having one.
// ============================================================

router.get('/items/:id/variants', async (req, res) => {
    const item = await MatWhItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const rows = await MatWhItemVariant.findAll({ where: { itemId: item.id }, order: [['id', 'ASC']] });
    res.json({ items: rows });
});

// Replace-the-whole-set, same diff pattern as PUT /items/:id/stores --
// rows carrying their own `id` are updated in place, rows without one are
// created, and any existing row missing from the submitted set is deleted.
// Barcode uniqueness (globally, not just per item) is a real DB constraint
// here, not just a UI nicety -- a collision surfaces as a clear 409, not a
// raw 500.
router.put('/items/:id/variants', async (req, res) => {
    const item = await MatWhItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const incoming = Array.isArray(req.body?.variants) ? req.body.variants : [];

    const submittedWithId = incoming.filter((v) => v?.id);
    const submittedNew = incoming.filter((v) => !v?.id);
    const keepIds = submittedWithId.map((v) => Number(v.id));

    const existing = await MatWhItemVariant.findAll({ where: { itemId: item.id } });
    const toRemove = existing.filter((r) => !keepIds.includes(r.id));

    try {
        if (toRemove.length > 0) {
            await MatWhItemVariant.destroy({ where: { itemId: item.id, id: toRemove.map((r) => r.id) } });
        }
        for (const v of submittedWithId) {
            const row = existing.find((r) => r.id === Number(v.id));
            if (!row) continue;
            await row.update({
                color: v.color || null,
                lengthMm: v.lengthMm === '' || v.lengthMm == null ? null : Number(v.lengthMm),
                barcode: String(v.barcode || '').trim(),
                isActive: v.isActive !== false,
            });
        }
        for (const v of submittedNew) {
            if (!v.barcode || !String(v.barcode).trim()) continue;
            await MatWhItemVariant.create({
                itemId: item.id,
                color: v.color || null,
                lengthMm: v.lengthMm === '' || v.lengthMm == null ? null : Number(v.lengthMm),
                barcode: String(v.barcode).trim(),
                isActive: v.isActive !== false,
            });
        }
    } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: 'That barcode is already assigned to another variant' });
        }
        console.error('Error saving item variants:', err);
        return res.status(500).json({ message: 'Failed to save variants' });
    }

    const rows = await MatWhItemVariant.findAll({ where: { itemId: item.id }, order: [['id', 'ASC']] });
    res.json({ items: rows });
});

export default router;
