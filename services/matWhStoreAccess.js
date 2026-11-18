// backend/services/matWhStoreAccess.js
// Per-user store scoping for Materials Warehouse ACTIONS, backed by
// matWhUserStoreAssignments (see MatWhUserStoreAssignment.js).
//
// Rules (agreed 2026-10-15, tightened 2026-10-29 at the user's request):
//   - admin: every store.
//   - a user with one or more rows: only those stores.
//   - a store role (STORE_ROLES) with NO rows: no store at all -- a new
//     storekeeper sees and does nothing until an admin assigns stores.
//   - any other role with no rows (production, mix, ...): every store,
//     unchanged -- their work isn't tied to one store.
// Both actions AND viewing are scoped: lists, stock and reports only show
// the allowed stores (storeWhere / storeSql / filterStores below). A
// transfer's destination picker is the one place other stores still
// appear, by name only.
import { MatWhUserStoreAssignment } from '../models/MatWhUserStoreAssignment.js';
import { MatWhStore } from '../models/MatWhStore.js';

export const STORE_ROLES = new Set(['material_user', 'store_manager']);

// null = every store; otherwise a Set of storeIds (possibly empty).
export async function getAllowedStoreIds(user) {
    if (!user || user.role === 'admin') return null;
    const rows = await MatWhUserStoreAssignment.findAll({ where: { userId: user.userId }, attributes: ['storeId'] });
    if (rows.length) return new Set(rows.map((r) => r.storeId));
    return STORE_ROLES.has(user.role) ? new Set() : null;
}

// Sequelize where fragment limiting a store column to the allowed stores
// ({} when every store is allowed; an empty set matches nothing).
export function storeWhere(allowed, field = 'storeId') {
    return allowed === null ? {} : { [field]: [...allowed, -1] };
}

// Raw-SQL equivalent: "" or " AND <column> IN (...)". The ids come from
// the DB, never from the request.
export function storeSql(allowed, column) {
    return allowed === null ? '' : ` AND ${column} IN (${[...allowed, -1].map(Number).join(',')})`;
}

// Keeps the allowed entries of a list of store ids, or of rows carrying a
// store id in `field`.
export function filterStores(allowed, list, field = null) {
    if (allowed === null) return list;
    return list.filter((x) => allowed.has(Number(field ? x[field] : x)));
}

export function canActOnStore(allowed, storeId) {
    return allowed === null || allowed.has(Number(storeId));
}

// Throws a 403 naming the first store the user isn't assigned to.
export async function assertStoreAccess(user, ...storeIds) {
    const allowed = await getAllowedStoreIds(user);
    const denied = storeIds.filter((id) => id != null && !canActOnStore(allowed, id));
    if (denied.length === 0) return;
    const store = await MatWhStore.findByPk(denied[0]);
    const err = new Error(`You are not assigned to store ${store ? `${store.storeCode} - ${store.storeName}` : denied[0]}`);
    err.status = 403;
    err.code = 'STORE_ACCESS';
    throw err;
}

// Route-handler convenience: sends the 403 itself and returns true when
// denied, so call sites stay one line: `if (await denyStore(req, res, id)) return;`
export async function denyStore(req, res, ...storeIds) {
    try {
        await assertStoreAccess(req.user, ...storeIds);
        return false;
    } catch (err) {
        if (err.code !== 'STORE_ACCESS') throw err;
        res.status(403).json({ message: err.message, code: err.code });
        return true;
    }
}
