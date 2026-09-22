// backend/middleware/ipBlock.js
// Admin-managed IP blocklist, checked on every request before it reaches
// any route. Same cache shape as middleware/permissions.js's grantsByRole
// (module-level, 60s TTL, invalidated immediately on write) -- a query
// per request would add DB latency to literally everything, and this
// backend is a single Node process (see that file's own comment on what
// would need to change if that stops being true).
import { BlockedIp } from '../models/BlockedIp.js';

const CACHE_TTL_MS = 60_000;

let blockedIps = null; // Set<string> | null (null = not loaded yet)
let loadedAt = 0;

async function loadBlockedIps() {
    const rows = await BlockedIp.findAll({ attributes: ['ip'] });
    blockedIps = new Set(rows.map((r) => r.ip));
    loadedAt = Date.now();
    return blockedIps;
}

async function getBlockedIps() {
    if (!blockedIps || Date.now() - loadedAt > CACHE_TTL_MS) {
        await loadBlockedIps();
    }
    return blockedIps;
}

// Call after every write to BlockedIps so a new block/unblock takes
// effect on the very next request, same reasoning as
// invalidatePermissionsCache.
export function invalidateBlockedIpsCache() {
    blockedIps = null;
    loadedAt = 0;
}

// Mounted globally in index.js, ahead of every route -- a blocked IP
// never reaches auth, static files, or anything else. 403 with a generic
// message (not "IP blocked") so it doesn't confirm to an attacker that
// they've specifically been IP-blocked vs. just getting a routine error.
export async function blockIpMiddleware(req, res, next) {
    try {
        const blocked = await getBlockedIps();
        if (blocked.has(req.ip)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        next();
    } catch (err) {
        console.error('❌ IP BLOCK CHECK ERROR:', err);
        // Fail open -- a DB hiccup here must never take the whole app down
        // for every visitor.
        next();
    }
}
