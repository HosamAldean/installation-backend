// backend/routes/audit.js
// Admin-only endpoints backing the Audit Log screen (frontend/src/pages/
// admin/AuditLog.tsx): login history (LoginAudit -- both success and
// failure, see that model's header comment) and a live snapshot of which
// accounts are currently online. Hardcoded admin-only (not a
// PermissionGrant key) -- login/IP history is sensitive enough that it
// shouldn't be admin-delegable the way most modules are, same reasoning as
// the 4 existing RoleProtectedRoute-gated admin-only pages.
import express from "express";
import { Op, fn, col, literal } from "sequelize";
import { authenticateToken, authorizeRoles, setCachedSessionVersion } from "../middleware/auth.js";
import { LoginAudit } from "../models/LoginAudit.js";
import { SecurityAlert } from "../models/SecurityAlert.js";
import { PermissionGrantAudit } from "../models/PermissionGrantAudit.js";
import { UserAccountAudit } from "../models/UserAccountAudit.js";
import { AdminActionAudit } from "../models/AdminActionAudit.js";
import { UnauthorizedAccessAudit } from "../models/UnauthorizedAccessAudit.js";
import { User } from "../models/User.js";
import { resolveUserNames } from "../utils/userLookup.js";
import { LATEST_VERSION_CODE, LATEST_VERSION_NAME, MIN_SUPPORTED_VERSION_CODE, UPDATE_PAGE_URL } from "../constants/mobileAppVersion.js";
import { sequelize, sequelize2, sequelize3, getSqlPool, getSqlServerKeys } from "../config/db.js";
import { sseClients } from "../sse.js";
import { getRateLimitedIdentities, clearRateLimitKey } from "./auth.js";
import { BlockedIp } from "../models/BlockedIp.js";
import { invalidateBlockedIpsCache } from "../middleware/ipBlock.js";

const router = express.Router();
router.use(authenticateToken, authorizeRoles("admin"));

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize) || DEFAULT_PAGE_SIZE));
    return { page, pageSize };
}

// ============================================================
// GET /login-history -- paginated, filterable login attempts (success and
// failure). Filters: username (partial match), ip (partial match),
// success ('yes'/'no'), dateFrom/dateTo (on createdAt).
// ============================================================
router.get("/login-history", async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { username, ip, success, dateFrom, dateTo } = req.query;

        const where = {};
        if (username) where.username = { [Op.like]: `%${username}%` };
        if (ip) where.ip = { [Op.like]: `%${ip}%` };
        if (success === "yes") where.success = true;
        else if (success === "no") where.success = false;
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const total = await LoginAudit.count({ where });
        const rows = await LoginAudit.findAll({
            where,
            order: [["createdAt", "DESC"]],
            offset: (page - 1) * pageSize,
            limit: pageSize,
        });

        const userNames = await resolveUserNames(rows.map((r) => r.userId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            user: r.userId ? (userNames[r.userId] || null) : null,
        }));

        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ AUDIT LOGIN HISTORY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch login history" });
    }
});

// ============================================================
// GET /suspicious-activity -- aggregates LoginAudit's failed attempts
// (same table /login-history browses row-by-row) into top-attacked
// usernames and top-offending IPs, so a brute-force pattern is visible
// directly in the admin UI instead of only through manually watching the
// backend log. Optional dateFrom/dateTo (defaults to unbounded -- this
// table is new and still small); limit caps each list (default 20).
// ============================================================
router.get("/suspicious-activity", async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

        const where = { success: false };
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const topUsernamesRaw = await LoginAudit.findAll({
            where,
            attributes: [
                "username",
                [fn("COUNT", col("id")), "failCount"],
                [fn("MAX", col("createdAt")), "lastAttemptAt"],
            ],
            group: ["username"],
            order: [[literal("failCount"), "DESC"]],
            limit,
            raw: true,
        });

        const topIpsRaw = await LoginAudit.findAll({
            where: { ...where, ip: { [Op.ne]: null } },
            attributes: [
                "ip",
                [fn("COUNT", col("id")), "failCount"],
                [fn("COUNT", fn("DISTINCT", col("username"))), "distinctUsernames"],
                [fn("MAX", col("createdAt")), "lastAttemptAt"],
            ],
            group: ["ip"],
            order: [[literal("failCount"), "DESC"]],
            limit,
            raw: true,
        });

        // Attacking a username that doesn't even correspond to a real
        // account (e.g. "admin1234") is a different, lower-signal event
        // than repeatedly guessing a real employee's password -- flagged
        // here so the UI can distinguish them at a glance.
        const realUsers = await User.findAll({
            where: { username: topUsernamesRaw.map((u) => u.username) },
            attributes: ["username"],
        });
        const realUsernames = new Set(realUsers.map((u) => u.username));

        res.json({
            success: true,
            topUsernames: topUsernamesRaw.map((u) => ({
                ...u,
                failCount: Number(u.failCount),
                isRealAccount: realUsernames.has(u.username),
            })),
            topIps: topIpsRaw.map((r) => ({
                ...r,
                failCount: Number(r.failCount),
                distinctUsernames: Number(r.distinctUsernames),
            })),
        });
    } catch (err) {
        console.error("❌ AUDIT SUSPICIOUS ACTIVITY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch suspicious activity" });
    }
});

// ============================================================
// GET /suspicious-activity/username/:username/ips -- drill-down for the
// "Top Attacked Usernames" table: every distinct IP that has attempted
// (and failed) this username, most-frequent first.
// ============================================================
router.get("/suspicious-activity/username/:username/ips", async (req, res) => {
    try {
        const rows = await LoginAudit.findAll({
            where: { success: false, username: req.params.username, ip: { [Op.ne]: null } },
            attributes: [
                "ip",
                [fn("COUNT", col("id")), "failCount"],
                [fn("MAX", col("createdAt")), "lastAttemptAt"],
            ],
            group: ["ip"],
            order: [[literal("failCount"), "DESC"]],
            limit: 50,
            raw: true,
        });
        res.json({ success: true, ips: rows.map((r) => ({ ...r, failCount: Number(r.failCount) })) });
    } catch (err) {
        console.error("❌ AUDIT SUSPICIOUS USERNAME DRILLDOWN ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch IPs for username" });
    }
});

// ============================================================
// GET /suspicious-activity/ip/:ip/usernames -- drill-down for the "Top
// Offending IPs" table: every distinct username that IP has tried (and
// failed), most-frequent first.
// ============================================================
router.get("/suspicious-activity/ip/:ip/usernames", async (req, res) => {
    try {
        const rows = await LoginAudit.findAll({
            where: { success: false, ip: req.params.ip },
            attributes: [
                "username",
                [fn("COUNT", col("id")), "failCount"],
                [fn("MAX", col("createdAt")), "lastAttemptAt"],
            ],
            group: ["username"],
            order: [[literal("failCount"), "DESC"]],
            limit: 50,
            raw: true,
        });
        res.json({ success: true, usernames: rows.map((r) => ({ ...r, failCount: Number(r.failCount) })) });
    } catch (err) {
        console.error("❌ AUDIT SUSPICIOUS IP DRILLDOWN ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch usernames for IP" });
    }
});

// ============================================================
// GET /security-alerts -- automatically-detected credential-spray events
// (services/securityMonitor.js), newest first. Not paginated -- expected
// to stay a small, infrequent list; unacknowledged ones are what the admin
// UI surfaces prominently.
// ============================================================
router.get("/security-alerts", async (req, res) => {
    try {
        const rows = await SecurityAlert.findAll({ order: [["createdAt", "DESC"]], limit: 100 });
        const userNames = await resolveUserNames(rows.map((r) => r.acknowledgedByUserId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            usernames: r.usernames ? JSON.parse(r.usernames) : [],
            acknowledgedBy: r.acknowledgedByUserId ? (userNames[r.acknowledgedByUserId] || null) : null,
        }));
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ AUDIT SECURITY ALERTS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch security alerts" });
    }
});

// ============================================================
// PUT /security-alerts/:id/acknowledge -- marks an alert reviewed. Doesn't
// block/unblock anything itself -- an admin who decides the IP is real
// still uses the existing POST /blocked-ips separately.
// ============================================================
router.put("/security-alerts/:id/acknowledge", async (req, res) => {
    try {
        const row = await SecurityAlert.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });
        await row.update({ acknowledged: true, acknowledgedByUserId: req.user.userId, acknowledgedAt: new Date() });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ AUDIT SECURITY ALERT ACKNOWLEDGE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to acknowledge alert" });
    }
});

// ============================================================
// GET /user-account-changes -- paginated, filterable history of every
// security/privilege-relevant account change (see models/
// UserAccountAudit.js -- create/role-change/activate/deactivate/
// password-reset/delete). Filters: username (partial match), action,
// dateFrom/dateTo.
// ============================================================
router.get("/user-account-changes", async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { username, action, dateFrom, dateTo } = req.query;

        const where = {};
        if (username) where.targetUsername = { [Op.like]: `%${username}%` };
        if (action) where.action = action;
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const total = await UserAccountAudit.count({ where });
        const rows = await UserAccountAudit.findAll({
            where,
            order: [["createdAt", "DESC"]],
            offset: (page - 1) * pageSize,
            limit: pageSize,
        });

        const userNames = await resolveUserNames(rows.map((r) => r.performedByUserId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            performedBy: r.performedByUserId ? (userNames[r.performedByUserId] || null) : null,
        }));

        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ AUDIT USER ACCOUNT CHANGES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch user account changes" });
    }
});

// ============================================================
// GET /admin-action-changes -- paginated, filterable history of edits to
// admin-only reference/catalog data (Lookups, Profile Assemblies, Item
// Profiles -- see models/AdminActionAudit.js). Filters: module, action,
// dateFrom/dateTo.
// ============================================================
router.get("/admin-action-changes", async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { module, action, dateFrom, dateTo } = req.query;

        const where = {};
        if (module) where.module = module;
        if (action) where.action = action;
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const total = await AdminActionAudit.count({ where });
        const rows = await AdminActionAudit.findAll({
            where,
            order: [["createdAt", "DESC"]],
            offset: (page - 1) * pageSize,
            limit: pageSize,
        });

        const userNames = await resolveUserNames(rows.map((r) => r.performedByUserId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            performedBy: r.performedByUserId ? (userNames[r.performedByUserId] || null) : null,
        }));

        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ AUDIT ADMIN ACTION CHANGES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch admin action changes" });
    }
});

// ============================================================
// GET /unauthorized-access -- paginated, filterable history of 403s from
// the app's real authorization chokepoints (see models/
// UnauthorizedAccessAudit.js). Filters: role, path (partial match),
// dateFrom/dateTo.
// ============================================================
router.get("/unauthorized-access", async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { role, path, dateFrom, dateTo } = req.query;

        const where = {};
        if (role) where.role = role;
        if (path) where.path = { [Op.like]: `%${path}%` };
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const total = await UnauthorizedAccessAudit.count({ where });
        const rows = await UnauthorizedAccessAudit.findAll({
            where,
            order: [["createdAt", "DESC"]],
            offset: (page - 1) * pageSize,
            limit: pageSize,
        });

        const userNames = await resolveUserNames(rows.map((r) => r.userId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            user: r.userId ? (userNames[r.userId] || null) : null,
        }));

        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ AUDIT UNAUTHORIZED ACCESS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch unauthorized access log" });
    }
});

// ============================================================
// GET /online-users -- live snapshot of accounts currently marked online
// (User.isOnline), with their last-seen time and last-known mobile app
// version. Not paginated -- expected to be a small set at any given time.
// ============================================================
router.get("/online-users", async (req, res) => {
    try {
        const users = await User.findAll({
            where: { isOnline: true },
            attributes: [
                "userId", "username", "firstName", "lastName", "role",
                "assignedEmpNo", "lastSeenAt",
                "lastMobileAppVersionCode", "lastMobileAppVersionCheckedAt",
            ],
            order: [["lastSeenAt", "DESC"]],
        });
        res.json({ success: true, users });
    } catch (err) {
        console.error("❌ AUDIT ONLINE USERS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch online users" });
    }
});

// ============================================================
// GET /mobile-version-summary -- active users grouped by their last-known
// mobile app versionCode (User.lastMobileAppVersionCode, updated on every
// mobile login attempt -- see routes/auth.js). Answers "how many people
// are still on a stale build" without waiting for push delivery/login-time
// blocking alone to surface it. Not paginated (same reasoning as
// /online-users -- expected to be a small, bounded set: active accounts
// only). null-versionCode group covers accounts that have never logged in
// from mobile at all (web-only users, or a build old enough to predate
// this field entirely -- see that constant file's own comment on why
// those can't be detected any other way).
// ============================================================
router.get("/mobile-version-summary", async (req, res) => {
    try {
        const users = await User.findAll({
            where: { active: true },
            attributes: [
                "userId", "username", "firstName", "lastName",
                "assignedEmpNo", "lastMobileAppVersionCode", "lastMobileAppVersionCheckedAt",
            ],
        });

        const groupsByVersion = new Map();
        for (const u of users) {
            const key = u.lastMobileAppVersionCode ?? null;
            if (!groupsByVersion.has(key)) groupsByVersion.set(key, []);
            groupsByVersion.get(key).push({
                userId: u.userId,
                name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username,
                username: u.username,
                assignedEmpNo: u.assignedEmpNo,
                lastMobileAppVersionCheckedAt: u.lastMobileAppVersionCheckedAt,
            });
        }

        const groups = [...groupsByVersion.entries()]
            .map(([appVersionCode, groupUsers]) => ({
                appVersionCode,
                count: groupUsers.length,
                users: groupUsers,
            }))
            .sort((a, b) => {
                // null (never used mobile) always sorts last -- it's not a
                // "how stale" data point, so it shouldn't interleave with
                // the actual version numbers.
                if (a.appVersionCode === null) return 1;
                if (b.appVersionCode === null) return -1;
                return b.appVersionCode - a.appVersionCode;
            });

        res.json({
            success: true,
            latestVersionCode: LATEST_VERSION_CODE,
            latestVersionName: LATEST_VERSION_NAME,
            minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE,
            groups,
        });
    } catch (err) {
        console.error("❌ AUDIT MOBILE VERSION SUMMARY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch mobile version summary" });
    }
});

// ============================================================
// GET /permission-changes -- paginated, filterable history of every
// permission grant/revoke event. Filters: role, permissionKey (exact
// match -- picked from a dropdown, unlike login-history's partial-match
// text filters), action ('granted'/'revoked'), dateFrom/dateTo.
// ============================================================
router.get("/permission-changes", async (req, res) => {
    try {
        const { page, pageSize } = parsePagination(req.query);
        const { role, permissionKey, action, dateFrom, dateTo } = req.query;

        const where = {};
        if (role) where.role = role;
        if (permissionKey) where.permissionKey = permissionKey;
        if (action === "granted" || action === "revoked") where.action = action;
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt[Op.gte] = new Date(`${dateFrom}T00:00:00`);
            if (dateTo) where.createdAt[Op.lte] = new Date(`${dateTo}T23:59:59`);
        }

        const total = await PermissionGrantAudit.count({ where });
        const rows = await PermissionGrantAudit.findAll({
            where,
            order: [["createdAt", "DESC"]],
            offset: (page - 1) * pageSize,
            limit: pageSize,
        });

        const userNames = await resolveUserNames(rows.map((r) => r.performedByUserId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            performedBy: r.performedByUserId ? (userNames[r.performedByUserId] || null) : null,
        }));

        res.json({ success: true, items, total, page, pageSize });
    } catch (err) {
        console.error("❌ AUDIT PERMISSION CHANGES ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch permission changes" });
    }
});

// ============================================================
// PUT /force-logout/:userId -- immediately invalidates every session this
// user currently holds, same mechanism as a normal login's single-active-
// session enforcement (bump sessionVersion; every already-issued JWT
// embeds the old value, so middleware/auth.js rejects them all on their
// next request). Updates the in-memory cache immediately too -- otherwise
// the old sessionVersion would stay accepted until that cache entry's TTL
// naturally expires, same reasoning as /login's own cache update.
// ============================================================
router.put("/force-logout/:userId", async (req, res) => {
    try {
        const user = await User.findByPk(req.params.userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const newSessionVersion = user.sessionVersion + 1;
        await user.update({ isOnline: false, sessionVersion: newSessionVersion });
        setCachedSessionVersion(user.userId, newSessionVersion);

        res.json({ success: true });
    } catch (err) {
        console.error("❌ AUDIT FORCE LOGOUT ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to force logout" });
    }
});

// Same origin as the mobile update page (UPDATE_PAGE_URL) -- the public,
// off-LAN-reachable hostname (petralu.duckdns.org), not a relative path.
// Used below as a genuine end-to-end reachability check: if THIS backend
// can round-trip a request to itself through that public hostname, the
// whole external path (DuckDNS -> port-forward/tunnel -> this process) is
// actually working, which is exactly what the external tunnel-health
// monitor script is trying to answer -- just via a mechanism this app can
// run itself, with no dependency on the devtunnel CLI being installed/
// authenticated in this process's context.
const PUBLIC_HEALTH_URL = new URL('/api/health', UPDATE_PAGE_URL).toString();

async function timedCheck(fn, timeoutMs = 5000) {
    const start = Date.now();
    try {
        await Promise.race([
            fn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ]);
        return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
        return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
}

// ============================================================
// GET /system-health -- live snapshot of backend process health: both
// MySQL connections, every configured SQL Server pool, the SSE client
// count, process uptime/memory, and an end-to-end reachability check of
// the public URL (see PUBLIC_HEALTH_URL above). Not cached/paginated --
// meant to be polled occasionally from the admin System Health panel, not
// hit on every page load.
// ============================================================
router.get("/system-health", async (req, res) => {
    try {
        const [mysqlPrimary, mysqlSecondary, mysqlSecondary3] = await Promise.all([
            timedCheck(() => sequelize.authenticate()),
            timedCheck(() => sequelize2.authenticate()),
            timedCheck(() => sequelize3.authenticate()),
        ]);

        const sqlServerKeys = getSqlServerKeys();
        const sqlServerEntries = await Promise.all(
            sqlServerKeys.map(async (key) => {
                const result = await timedCheck(async () => {
                    const pool = await getSqlPool(key);
                    await pool.request().query("SELECT 1");
                });
                return [key, result];
            })
        );

        const publicUrlCheck = await timedCheck(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
                const r = await fetch(PUBLIC_HEALTH_URL, { signal: controller.signal });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
            } finally {
                clearTimeout(timeout);
            }
        }, 7000);

        const mem = process.memoryUsage();
        res.json({
            success: true,
            uptimeSeconds: Math.round(process.uptime()),
            memory: {
                rssMb: Math.round(mem.rss / 1024 / 1024),
                heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            },
            mysql: {
                sequelize: mysqlPrimary,
                sequelize2: mysqlSecondary,
                sequelize3: mysqlSecondary3,
            },
            sqlServers: Object.fromEntries(sqlServerEntries),
            sse: { connectedClients: sseClients.size },
            publicUrl: { url: PUBLIC_HEALTH_URL, ...publicUrlCheck },
        });
    } catch (err) {
        console.error("❌ AUDIT SYSTEM HEALTH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch system health" });
    }
});

// Fire-and-forget, same reasoning as routes/lookups.js's logLookupAction --
// a logging failure must never affect the actual unblock it's describing.
function logRateLimitClear({ identityValue, path, req }) {
    AdminActionAudit.create({
        module: "rate_limit",
        entityId: identityValue,
        entityLabel: path ? `${identityValue} (${path})` : identityValue,
        action: "deleted",
        performedByUserId: req.user?.userId ?? null,
    }).catch((err) => {
        console.error("❌ Failed to record admin action audit:", err);
    });
}

// ============================================================
// GET /rate-limits -- everyone currently locked out of a login (or other
// rate-limited endpoint) by routes/auth.js's in-memory attempt counter.
// Not paginated -- expected to be a small, bounded set (only entries
// actually AT the attempt limit right now, see getRateLimitedIdentities).
// ============================================================
router.get("/rate-limits", async (req, res) => {
    try {
        res.json({ success: true, items: getRateLimitedIdentities() });
    } catch (err) {
        console.error("❌ AUDIT RATE LIMITS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch rate-limited accounts" });
    }
});

// ============================================================
// PUT /rate-limits/clear -- immediately lifts one block (deletes its
// attempt history outright, see clearRateLimitKey), rather than waiting
// out the remaining time on the 15-minute window.
// ============================================================
router.put("/rate-limits/clear", async (req, res) => {
    try {
        const { key, identityValue, path } = req.body;
        if (!key) {
            return res.status(400).json({ success: false, message: "key is required" });
        }
        const cleared = clearRateLimitKey(key);
        if (cleared) {
            logRateLimitClear({ identityValue, path, req });
        }
        res.json({ success: true, cleared });
    } catch (err) {
        console.error("❌ AUDIT RATE LIMIT CLEAR ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to clear rate limit" });
    }
});

// Fire-and-forget, same reasoning as routes/lookups.js's logLookupAction --
// a logging failure must never affect the actual write it's describing.
function logIpBlockAction({ ip, action, req }) {
    AdminActionAudit.create({
        module: "ip_block",
        entityId: ip,
        entityLabel: ip,
        action,
        performedByUserId: req.user?.userId ?? null,
    }).catch((err) => {
        console.error("❌ Failed to record admin action audit:", err);
    });
}

// ============================================================
// GET /blocked-ips -- the full admin-managed IP blocklist (see models/
// BlockedIp.js / middleware/ipBlock.js). Not paginated -- expected to
// stay a small, deliberately-curated list.
// ============================================================
router.get("/blocked-ips", async (req, res) => {
    try {
        const rows = await BlockedIp.findAll({ order: [["createdAt", "DESC"]] });
        const userNames = await resolveUserNames(rows.map((r) => r.blockedByUserId));
        const items = rows.map((r) => ({
            ...r.toJSON(),
            blockedBy: r.blockedByUserId ? (userNames[r.blockedByUserId] || null) : null,
        }));
        res.json({ success: true, items });
    } catch (err) {
        console.error("❌ AUDIT BLOCKED IPS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to fetch blocked IPs" });
    }
});

// ============================================================
// POST /blocked-ips -- block a new IP. Refuses to block the caller's own
// current IP (req.ip) -- same self-lockout guard as the bulk user actions
// (routes/users.js) excluding the caller's own account, just for a
// network address instead of an account.
// ============================================================
router.post("/blocked-ips", async (req, res) => {
    try {
        const ip = String(req.body.ip || "").trim();
        if (!ip) {
            return res.status(400).json({ success: false, message: "ip is required" });
        }
        if (ip === req.ip) {
            return res.status(400).json({ success: false, message: "You can't block your own current IP" });
        }
        const row = await BlockedIp.create({
            ip,
            reason: req.body.reason ? String(req.body.reason).trim() : null,
            blockedByUserId: req.user.userId,
        });
        invalidateBlockedIpsCache();
        logIpBlockAction({ ip, action: "created", req });
        res.status(201).json({ success: true, item: row });
    } catch (err) {
        if (err.name === "SequelizeUniqueConstraintError") {
            return res.status(409).json({ success: false, message: "That IP is already blocked" });
        }
        console.error("❌ AUDIT BLOCK IP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to block IP" });
    }
});

// ============================================================
// DELETE /blocked-ips/:id -- unblock.
// ============================================================
router.delete("/blocked-ips/:id", async (req, res) => {
    try {
        const row = await BlockedIp.findByPk(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: "Not found" });
        const { ip } = row;
        await row.destroy();
        invalidateBlockedIpsCache();
        logIpBlockAction({ ip, action: "deleted", req });
        res.json({ success: true });
    } catch (err) {
        console.error("❌ AUDIT UNBLOCK IP ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to unblock IP" });
    }
});

export default router;
