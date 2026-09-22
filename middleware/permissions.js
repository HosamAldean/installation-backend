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
import { recordUnauthorizedAccess } from '../utils/unauthorizedAccessLog.js';

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
                recordUnauthorizedAccess({
                    userId: req.user.userId,
                    role: req.user.role,
                    method: req.method,
                    path: req.originalUrl,
                    requiredAccess: `permission: ${key}`,
                    ip: req.ip,
                });
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            next();
        } catch (err) {
            console.error('Permission check failed:', err);
            res.status(500).json({ success: false, message: 'Permission check failed' });
        }
    };
}

// Roles that must never be able to mutate anything, no matter which
// permission keys they're granted -- installation_supervisor exists purely
// to view orders/schedule/team assignments (see routes/instOrders.js and
// routes/teams.js), so a granted permission key there only ever unlocks
// GET/HEAD for it. Apply right after requirePermission(...) on any router
// where this matters.
// All HR-tier roles (added 2026-08-27) are here for the same reason,
// scoped to the same two routers -- oversight visibility into the
// Follow-up/Installation module (dashboard, reports, employees, requests,
// teams, steps), no write access. Safe to share this set with
// installation_supervisor because HR's own real write endpoints
// (leave/transport/attendance requests, HR reports) live entirely in
// different routers (hrRequests.js, hrReports.js, etc.) that never wire
// this middleware in.
const READ_ONLY_ROLES = new Set([
    'installation_supervisor',
    'hr',
    'hr_manager',
    'hr_factory',
    'hr_ittihad',
]);

export function blockWritesForReadOnlyRoles(req, res, next) {
    const isReadOnlyMethod = req.method === 'GET' || req.method === 'HEAD';
    if (READ_ONLY_ROLES.has(req.user?.role) && !isReadOnlyMethod) {
        recordUnauthorizedAccess({
            userId: req.user?.userId,
            role: req.user?.role,
            method: req.method,
            path: req.originalUrl,
            requiredAccess: 'read-only role restriction',
            ip: req.ip,
        });
        return res.status(403).json({ success: false, message: 'This role has view-only access' });
    }
    next();
}

// gm holds oversight VIEW keys on the HR/Accounting queues and reports
// (HR_REQUESTS_QUEUE, ACCOUNTING_REQUESTS_QUEUE, HR_REPORTS_*,
// HR_ITTIHAD_ATTENDANCE -- see seed-permission-grants.js) but must never be
// able to act there -- approve/reject a request, mark a payment made, mark
// a report exported, import/delete Ittihad attendance data. Deliberately a
// SEPARATE function from blockWritesForReadOnlyRoles/READ_ONLY_ROLES above
// rather than adding 'gm' to that shared set: that set is checked
// identically everywhere the middleware is wired in, and gm needs FULL
// read/write elsewhere (Follow-up/Installation, where
// blockWritesForReadOnlyRoles is already applied router-wide in
// instOrders.js) -- adding gm to the shared set would silently block that
// too. Apply per-route (not router.use()) on any HR/Accounting router that
// also serves gm's own self-service submissions under a different
// permission key (e.g. hrRequests.js's POST /leave-requests uses
// HR_REQUESTS, not HR_REQUESTS_QUEUE) -- router.use() would wrongly block
// gm from submitting their own leave/transport/attendance requests too.
export function blockGmWrites(req, res, next) {
    const isReadOnlyMethod = req.method === 'GET' || req.method === 'HEAD';
    if (req.user?.role === 'gm' && !isReadOnlyMethod) {
        recordUnauthorizedAccess({
            userId: req.user?.userId,
            role: req.user?.role,
            method: req.method,
            path: req.originalUrl,
            requiredAccess: 'GM view-only restriction',
            ip: req.ip,
        });
        return res.status(403).json({ success: false, message: 'GM has view-only access to this area' });
    }
    next();
}
