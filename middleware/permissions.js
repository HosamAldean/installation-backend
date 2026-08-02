// backend/middleware/permissions.js
// Granular, admin-editable permission checks -- replaces the hardcoded
// authorizeRoles(...)/authorizeReadWrite(...) arrays across the app's
// route files. See backend/constants/permissions.js for the key list and
// the permission-system plan for the full design.
//
// Separate from middleware/auth.js on purpose: this does DB access +
// in-memory caching, a different concern from stateless JWT verification.
//
// Started as Petra-ERP-only; generalized to cover every module before
// merge, since the mechanism was always generic.
import { PermissionGrant } from '../models/PermissionGrant.js';
import { PERMISSIONS } from '../constants/permissions.js';

const CACHE_TTL_MS = 60_000;

// role -> Set<permissionKey>. Module-level cache -- this is safe as-is
// only because the backend runs as a single Node process today (`node
// index.js`, no PM2/cluster config anywhere in this repo). If that ever
// changes, this cache needs a shared invalidation signal (e.g. pub/sub)
// instead of the in-process Map below.
let grantsByRole = null; // Map<role, Set<permissionKey>> | null (null = not loaded yet)
let loadedAt = 0;

async function loadGrants() {
    const rows = await PermissionGrant.findAll({ attributes: ['role', 'permissionKey'] });
    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.role)) map.set(row.role, new Set());
        map.get(row.role).add(row.permissionKey);
    }
    grantsByRole = map;
    loadedAt = Date.now();
    return grantsByRole;
}

async function getGrantsByRole() {
    if (!grantsByRole || Date.now() - loadedAt > CACHE_TTL_MS) {
        await loadGrants();
    }
    return grantsByRole;
}

// Clears the cache immediately -- call after every write to the
// PermissionGrants table so a toggle in the admin UI takes effect on the
// very next request, without waiting for the TTL fallback above.
export function invalidatePermissionsCache() {
    grantsByRole = null;
    loadedAt = 0;
}

// Returns the granted permission keys for a role. admin gets every key
// (the bypass, made explicit here too so /auth/me's `permissions` field
// reflects reality for admins) -- everyone else gets whatever's granted,
// an empty array by default.
export async function getPermissionsForRole(role) {
    if (role === 'admin') {
        return Object.values(PERMISSIONS);
    }
    const map = await getGrantsByRole();
    return Array.from(map.get(role) ?? []);
}

// Express middleware factory -- same calling convention as
// authorizeRoles(...) in middleware/auth.js. admin bypasses this check
// entirely: it never needs a grant row, so an empty/corrupt table can
// never lock admin out.
export function requirePermission(key) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (req.user.role === 'admin') {
            return next();
        }
        try {
            const map = await getGrantsByRole();
            const granted = map.get(req.user.role);
            if (!granted || !granted.has(key)) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            next();
        } catch (err) {
            console.error('Permission check failed:', err);
            res.status(500).json({ success: false, message: 'Permission check failed' });
        }
    };
}
