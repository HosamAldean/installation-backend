// backend/routes/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { User } from '../models/User.js';
import { LoginAudit } from '../models/LoginAudit.js';
import { authenticateToken, authorizeRoles, setCachedSessionVersion } from '../middleware/auth.js';
import { getPermissionsForRole } from '../middleware/permissions.js';
import { MIN_SUPPORTED_VERSION_CODE, UPDATE_PAGE_URL } from '../constants/mobileAppVersion.js';

// Best-effort write to LoginAudits -- a logging failure should never block
// or fail the actual login flow, same reasoning as sendPushToUser's own
// try/catch elsewhere in this app.
async function recordLoginAudit({ username, userId, ip, appVersionCode, success, failureReason }) {
    try {
        await LoginAudit.create({
            username: username || '',
            userId: userId ?? null,
            ip: ip ?? null,
            platform: appVersionCode != null ? 'mobile' : 'web',
            success,
            failureReason: failureReason ?? null,
            appVersionCode: appVersionCode ?? null,
        });
    } catch (err) {
        console.error('❌ Failed to record login audit:', err);
    }
}

dotenv.config();
const router = express.Router();

// Rate limiting for auth endpoints. checkRateLimit() (no args, used for
// /signup and /change-password, where the caller isn't a bare username/
// password pair) keys by IP + path, same as before.
//
// /login instead keys by the *submitted username* (+ path) -- CORRECTED:
// this used to be IP-only everywhere, which meant multiple people/devices
// behind the same gateway (a small office network, or one real user's
// device seen at a LAN IP) shared a single bucket, so one person mistyping
// their password a couple times could lock every other real employee on
// that network out of login entirely for the rest of the window. Confirmed
// live during the Employee Gate rollout: a single device's 2 failed logins
// tripped the shared IP bucket and then kept re-tripping it on retry.
// Keying login by username instead means a lockout only ever affects the
// one account actually being guessed at, not everyone nearby -- the
// standard account-lockout brute-force defense, not a network-location one.
// Falls back to IP if the request has no usable username (e.g. malformed
// body) so it's never left completely unkeyed/unlimited.
//
// Confirmed live: the frontend was also silently swallowing this message
// (see apiRequest.ts's fix) — a locked-out user previously just saw a
// generic "Failed" instead of "Too many attempts," making this look like a
// broken login rather than a rate limit. That's fixed now, so this is at
// least visible when it happens.
const authAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

// onRejected -- optional, called (not awaited) when a request is blocked,
// so callers like /login can still get an audit trail entry for attempts
// that never reach the route handler at all.
const checkRateLimit = (keyFn, onRejected) => (req, res, next) => {
    const keyPrefix = keyFn ? keyFn(req) : req.ip;
    const key = `${keyPrefix}:${req.path}`;
    const now = Date.now();
    const attempts = authAttempts.get(key) || [];

    // Clean old attempts
    const recentAttempts = attempts.filter(time => now - time < RATE_LIMIT_WINDOW);

    if (recentAttempts.length >= MAX_ATTEMPTS) {
        onRejected?.(req);
        return res.status(429).json({
            success: false,
            message: 'Too many attempts. Please try again later.'
        });
    }

    recentAttempts.push(now);
    authAttempts.set(key, recentAttempts);
    next();
};

const loginRateLimitKey = (req) => {
    const username = req.body?.username;
    return typeof username === 'string' && username.trim()
        ? `user:${username.trim().toLowerCase()}`
        : `ip:${req.ip}`;
};

// The filter above only prunes stale timestamps out of each key's array —
// a key whose attempts have all aged out is never removed, so this Map
// grows by one entry per unique (ip, path) ever seen and never shrinks.
// Sweep it periodically instead.
setInterval(() => {
    const now = Date.now();
    for (const [key, attempts] of authAttempts) {
        const stillRecent = attempts.filter(time => now - time < RATE_LIMIT_WINDOW);
        if (stillRecent.length === 0) authAttempts.delete(key);
        else authAttempts.set(key, stillRecent);
    }
}, RATE_LIMIT_WINDOW).unref();

// Admin-facing view into (and control over) the in-memory rate limit
// above -- see backend/routes/audit.js's /rate-limits endpoints. Every
// key is `${keyPrefix}:${path}`, where path always starts with "/" and
// keyPrefix never contains "/", so splitting on the first ":/" cleanly
// separates the two regardless of what keyPrefix itself contains.
function parseRateLimitKey(key) {
    const splitAt = key.indexOf(':/');
    if (splitAt === -1) return { keyPrefix: key, path: null };
    return { keyPrefix: key.slice(0, splitAt), path: key.slice(splitAt + 1) };
}

// keyPrefix is "user:<username>" (loginRateLimitKey, when a username was
// submitted), "ip:<ip>" (loginRateLimitKey's own IP fallback), or a bare
// IP (every other route's default keyFn -- see checkRateLimit above).
function describeRateLimitIdentity(keyPrefix) {
    if (keyPrefix.startsWith('user:')) return { type: 'username', value: keyPrefix.slice(5) };
    if (keyPrefix.startsWith('ip:')) return { type: 'ip', value: keyPrefix.slice(3) };
    return { type: 'ip', value: keyPrefix };
}

// Only entries CURRENTLY blocking a request (>= MAX_ATTEMPTS within the
// window) -- an entry with fewer recent attempts is informational noise
// for this view, not something an admin needs to act on.
export function getRateLimitedIdentities() {
    const now = Date.now();
    const items = [];
    for (const [key, attempts] of authAttempts) {
        const recent = attempts.filter((t) => now - t < RATE_LIMIT_WINDOW);
        if (recent.length < MAX_ATTEMPTS) continue;
        const { keyPrefix, path } = parseRateLimitKey(key);
        const identity = describeRateLimitIdentity(keyPrefix);
        const oldestAttempt = Math.min(...recent);
        items.push({
            key,
            identityType: identity.type,
            identityValue: identity.value,
            path,
            attemptCount: recent.length,
            blockedUntil: new Date(oldestAttempt + RATE_LIMIT_WINDOW),
        });
    }
    return items;
}

// Deletes one key's attempt history outright -- the next request from
// that identity/path starts a fresh count, immediately lifting the block
// (rather than just trimming it down to just-under-the-limit).
export function clearRateLimitKey(key) {
    return authAttempts.delete(key);
}

// ======================
// Signup
// ======================
// Was unauthenticated and trusted a client-supplied `role` field — anyone
// could POST here with role: 'admin' and self-provision a fully privileged
// account. Not called from the frontend or mobile app (they use users.js's
// admin-gated POST / instead); require admin auth here too so trusting the
// body's role is safe the same way it already is there.
router.post('/signup', checkRateLimit(), authenticateToken, authorizeRoles('admin'), async (req, res) => {
    try {
        const { username, password, email, role, firstName, lastName, assignedEmpNo, assignedStore } = req.body;

        // Input validation
        if (!username || !password)
            return res.status(400).json({ message: 'Username and password required' });

        if (username.length < 3 || username.length > 50)
            return res.status(400).json({ message: 'Username must be 3-50 characters' });

        if (password.length < 6)
            return res.status(400).json({ message: 'Password must be at least 6 characters' });

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ message: 'Invalid email format' });

        const existing = await User.findOne({ where: { username } });
        if (existing)
            return res.status(409).json({ message: 'Username already exists' });

        const hash = await bcrypt.hash(password, 10);

        const user = await User.create({
            username,
            password: hash,
            email,
            role: role || 'installation_employee',
            firstName,
            lastName,
         //   teamId: teamId || null,
            assignedEmpNo: assignedEmpNo ? String(assignedEmpNo) : null, // ✅ ensure string or null
            assignedStore: assignedStore ? Number(assignedStore) : null,
            active: true
        });

        res.status(201).json({
            message: 'User created successfully',
            userId: user.userId,
            username: user.username,
            assignedEmpNo: user.assignedEmpNo,
            assignedStore: user.assignedStore
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ======================
// Login
// ======================
router.post('/login', checkRateLimit(loginRateLimitKey, (req) => {
    recordLoginAudit({
        username: req.body?.username,
        userId: null,
        ip: req.ip,
        appVersionCode: req.body?.appVersionCode,
        success: false,
        failureReason: 'rate_limited',
    });
}), async (req, res) => {
    try {
        const { username, password, appVersionCode } = req.body;

        // Input validation
        if (!username || !password)
            return res.status(400).json({ message: 'Username and password are required' });

        if (typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ message: 'Invalid input format' });

        const user = await User.findOne({ where: { username } });
        if (!user) {
            recordLoginAudit({ username, userId: null, ip: req.ip, appVersionCode, success: false, failureReason: 'invalid_credentials' });
            return res.status(401).json({ message: 'Invalid username or password' });
        }
        if (!user.active) {
            recordLoginAudit({ username, userId: user.userId, ip: req.ip, appVersionCode, success: false, failureReason: 'inactive' });
            return res.status(403).json({ message: 'User is inactive' });
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            recordLoginAudit({ username, userId: user.userId, ip: req.ip, appVersionCode, success: false, failureReason: 'invalid_credentials' });
            return res.status(401).json({ message: 'Invalid username or password' });
        }

        // Mobile-only (web's login form never sends appVersionCode, so it's
        // never affected by this): every build from the one that introduced
        // this field onward reports its own versionCode on every login
        // attempt, so a build that's fallen below MIN_SUPPORTED_VERSION_CODE
        // gets force-blocked before a token is ever issued -- "logged in but
        // then shown a mandatory update screen" (the HomeScreen gate) still
        // means the account looks online/active, this instead refuses the
        // session outright. Recorded regardless of pass/fail, so IT can see
        // which accounts are still attempting logins from a stale build.
        // Genuinely old builds that predate this field entirely can't be
        // caught here at all (they have no code to send it) -- those can
        // only be reached by directly notifying the person, e.g. via
        // scripts/notify-all-users-update.js's OS-level push broadcast.
        if (appVersionCode != null) {
            await user.update({
                lastMobileAppVersionCode: appVersionCode,
                lastMobileAppVersionCheckedAt: new Date(),
            });
            if (appVersionCode < MIN_SUPPORTED_VERSION_CODE) {
                recordLoginAudit({ username, userId: user.userId, ip: req.ip, appVersionCode, success: false, failureReason: 'update_required' });
                return res.status(426).json({
                    success: false,
                    code: 'UPDATE_REQUIRED',
                    message: 'Your app is out of date. Please update to continue.',
                    downloadUrl: UPDATE_PAGE_URL,
                });
            }
        }

        // Single-active-session enforcement: bump sessionVersion on every
        // login and embed it in this token, so any token issued by an
        // earlier login (still on some other device/tab) stops passing
        // middleware/auth.js's check as soon as this write lands. Update the
        // cache immediately -- otherwise the old session would stay valid
        // until that cache entry's TTL naturally expires.
        const newSessionVersion = user.sessionVersion + 1;
        await user.update({ isOnline: true, lastSeenAt: new Date(), sessionVersion: newSessionVersion });
        setCachedSessionVersion(user.userId, newSessionVersion);
        recordLoginAudit({ username, userId: user.userId, ip: req.ip, appVersionCode, success: true });

        const token = jwt.sign(
            {
                userId: user.userId,
                role: user.role,
             //   teamId: user.teamId || null,
                assignedEmpNo: user.assignedEmpNo || null,
                assignedStore: user.assignedStore ?? null,
                sessionVersion: newSessionVersion,
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        // ✅ Set HTTP-only cookie
        res.cookie('accessToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                userId: user.userId,
                username: user.username,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                active: user.active,
              //  teamId: user.teamId,
                assignedEmpNo: user.assignedEmpNo,
                assignedStore: user.assignedStore ?? null,
                avatarUrl: user.avatarUrl || null,
                // Mirrors /auth/me's payload.permissions -- the mobile app
                // persists this whole `user` object on-device and gates its
                // menu on permission keys instead of hardcoded roles, so
                // admin's grant-matrix toggles (routes/permissions.js)
                // control mobile visibility the same way they already
                // control web routing (see PermissionRoute.tsx).
                permissions: await getPermissionsForRole(user.role)
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ======================
// Logout (marks the user offline for the manager dashboard)
// ======================
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.userId);
        if (user) {
            await user.update({ isOnline: false });
        }
        res.clearCookie('accessToken');
        res.json({ success: true });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// ======================
// Change own password
// ======================
router.post('/change-password', checkRateLimit(), authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword)
            return res.status(400).json({ message: 'Current and new password are required' });

        if (newPassword.length < 6)
            return res.status(400).json({ message: 'New password must be at least 6 characters' });

        const user = await User.findByPk(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ======================
// Register a device's Expo push token (mobile app, on login)
// ======================
router.post('/push-token', authenticateToken, async (req, res) => {
    try {
        const { pushToken } = req.body;
        if (!pushToken || typeof pushToken !== 'string') {
            return res.status(400).json({ success: false, message: 'pushToken is required' });
        }

        const user = await User.findByPk(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        await user.update({ pushToken });
        res.json({ success: true });
    } catch (err) {
        console.error('Save push token error:', err);
        res.status(500).json({ success: false, message: 'Failed to save push token' });
    }
});

// ======================
// Get logged-in user
// ======================
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.userId, {
            attributes: [
                'userId',
                'username',
                'firstName',
                'lastName',
                'email',
                'role',
                'avatarUrl',
                'assignedEmpNo',
               // 'teamId',
            ],
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const payload = user.toJSON();
        payload.permissions = await getPermissionsForRole(payload.role);

        res.json({ user: payload });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch user info' });
    }
});

export default router;

