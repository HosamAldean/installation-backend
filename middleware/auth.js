// backend/middleware/auth.js
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { User } from '../models/User.js';
import { recordUnauthorizedAccess } from '../utils/unauthorizedAccessLog.js';
dotenv.config();

// Single-active-session enforcement: routes/auth.js's /login embeds the
// user's current InsUser.sessionVersion in every JWT it issues and bumps
// the DB value, so an older token (still cryptographically valid, not yet
// expired) becomes rejected here the moment a newer login happens
// elsewhere. Cached the same way middleware/permissions.js caches grants
// -- a short TTL plus immediate invalidation from the login route itself,
// rather than a DB round trip on every single authenticated request. Only
// valid because this backend runs as a single Node process (see that
// file's own comment for what would need to change if that stops being
// true).
const SESSION_CACHE_TTL_MS = 30_000;
const sessionVersionCache = new Map(); // userId -> { version, loadedAt }

async function getCurrentSessionVersion(userId) {
    const cached = sessionVersionCache.get(userId);
    if (cached && Date.now() - cached.loadedAt < SESSION_CACHE_TTL_MS) return cached.version;

    const user = await User.findByPk(userId, { attributes: ['sessionVersion'] });
    const version = user?.sessionVersion ?? null;
    sessionVersionCache.set(userId, { version, loadedAt: Date.now() });
    return version;
}

// Called right after /login writes the new sessionVersion, so the very
// next request (from either the new or the just-superseded session) sees
// the fresh value immediately instead of waiting out the TTL.
export function setCachedSessionVersion(userId, version) {
    sessionVersionCache.set(userId, { version, loadedAt: Date.now() });
}

// Authenticate JWT from cookie or header
export const authenticateToken = async (req, res, next) => {
    try {
        // EventSource (used for the SSE order-updates stream) can't set a
        // custom Authorization header or reliably send cross-origin cookies
        // in dev, so it passes the token as a query param instead — the only
        // caller that does this is useOrderStream.ts.
        const token =
            req.cookies?.accessToken ||
            req.headers.authorization?.split(' ')[1] ||
            req.query?.token;
        if (!token) return res.status(401).json({ success: false, message: 'No token provided', code: 'NO_TOKEN' });

        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // `code` lets clients tell "you got logged out because you signed in
        // elsewhere" (SESSION_SUPERSEDED) apart from an ordinary expired/
        // malformed token (TOKEN_INVALID) -- both frontend/src/utils/api.ts
        // and mobile/src/api.ts show a different message per code instead of
        // pattern-matching this route's English text.
        const currentVersion = await getCurrentSessionVersion(payload.userId);
        if (currentVersion === null || payload.sessionVersion !== currentVersion) {
            return res.status(401).json({
                success: false,
                message: 'You have been logged out because your account was signed in on another device',
                code: 'SESSION_SUPERSEDED',
            });
        }

        req.user = {
            userId: payload.userId,
            role: payload.role,
         //   teamId: payload.teamId || null,
            assignedEmpNo: payload.assignedEmpNo || null, // ✅ single source
            assignedStore: payload.assignedStore ?? null,
        };

        next();
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(401).json({ success: false, message: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
};

// Role-based authorization
export const authorizeRoles = (...roles) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
        recordUnauthorizedAccess({
            userId: req.user.userId,
            role: req.user.role,
            method: req.method,
            path: req.originalUrl,
            requiredAccess: `role: ${roles.join('/')}`,
            ip: req.ip,
        });
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
};

// Read/write split authorization -- some pages need a role that can view
// but not edit (e.g. installation_manager on Production Orders/Iron,
// which moved to production-role ownership but installation_manager still
// needs visibility). viewRoles must be the superset (anyone who can edit
// can also view); GET/HEAD requests only need viewRoles, every other
// method additionally requires editRoles.
export const authorizeReadWrite = (viewRoles, editRoles) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!viewRoles.includes(req.user.role)) {
        recordUnauthorizedAccess({
            userId: req.user.userId,
            role: req.user.role,
            method: req.method,
            path: req.originalUrl,
            requiredAccess: `role: ${viewRoles.join('/')}`,
            ip: req.ip,
        });
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const isReadOnlyMethod = req.method === 'GET' || req.method === 'HEAD';
    if (!isReadOnlyMethod && !editRoles.includes(req.user.role)) {
        recordUnauthorizedAccess({
            userId: req.user.userId,
            role: req.user.role,
            method: req.method,
            path: req.originalUrl,
            requiredAccess: `edit role: ${editRoles.join('/')}`,
            ip: req.ip,
        });
        return res.status(403).json({ success: false, message: 'You have view-only access to this page' });
    }
    next();
};
