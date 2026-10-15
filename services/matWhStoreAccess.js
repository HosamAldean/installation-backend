// backend/services/matWhStoreAccess.js
// Per-user store scoping for Materials Warehouse ACTIONS, backed by
// matWhUserStoreAssignments (see MatWhUserStoreAssignment.js).
//
// Rules (agreed 2026-10-15):
//   - admin: every store.
//   - a user with NO assignment rows: every store -- nothing changes for
//     anyone until an admin actually assigns stores, so rollout can't lock
//     a whole role out on day one.
//   - a user with one or more rows: only those stores.
// Only actions are scoped (confirm/issue/receive/count/transfer/write-off
// etc.) -- viewing stays open across stores, same "access check, not a
// per-row filter" principle Stock House settled on, so a storekeeper can
// still see where else an item is held before requesting a transfer.
import { MatWhUserStoreAssignment } from '../models/MatWhUserStoreAssignment.js';
import { MatWhStore } from '../models/MatWhStore.js';

// null = every store; otherwise a Set of storeIds.
export async function getAllowedStoreIds(user) {
    if (!user || user.role === 'admin') return null;
    const rows = await MatWhUserStoreAssignment.findAll({ where: { userId: user.userId }, attributes: ['storeId'] });
    return rows.length === 0 ? null : new Set(rows.map((r) => r.storeId));
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
