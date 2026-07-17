// backend/routes/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { User } from '../models/User.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

dotenv.config();
const router = express.Router();

// Rate limiting for auth endpoints. Keyed by IP + path — on a small
// internal network (or local dev testing), multiple people/processes behind
// the same gateway or machine share one bucket, so one person's failed
// attempts can lock out someone else on the same IP. Confirmed live: the
// frontend was also silently swallowing this message (see apiRequest.ts's
// fix) — a locked-out user previously just saw a generic "Failed" instead
// of "Too many attempts," making this look like a broken login rather than
// a rate limit. That's fixed now, so this is at least visible when it
// happens.
const authAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

const checkRateLimit = (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const attempts = authAttempts.get(key) || [];

    // Clean old attempts
    const recentAttempts = attempts.filter(time => now - time < RATE_LIMIT_WINDOW);

    if (recentAttempts.length >= MAX_ATTEMPTS) {
        return res.status(429).json({
            success: false,
            message: 'Too many attempts. Please try again later.'
        });
    }

    recentAttempts.push(now);
    authAttempts.set(key, recentAttempts);
    next();
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

// ======================
// Signup
// ======================
// Was unauthenticated and trusted a client-supplied `role` field — anyone
// could POST here with role: 'admin' and self-provision a fully privileged
// account. Not called from the frontend or mobile app (they use users.js's
// admin-gated POST / instead); require admin auth here too so trusting the
// body's role is safe the same way it already is there.
router.post('/signup', checkRateLimit, authenticateToken, authorizeRoles('admin'), async (req, res) => {
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
            role: role || 'user',
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
router.post('/login', checkRateLimit, async (req, res) => {
    try {
        const { username, password } = req.body;

        // Input validation
        if (!username || !password)
            return res.status(400).json({ message: 'Username and password are required' });

        if (typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ message: 'Invalid input format' });

        const user = await User.findOne({ where: { username } });
        if (!user) return res.status(401).json({ message: 'Invalid username or password' });
        if (!user.active) return res.status(403).json({ message: 'User is inactive' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ message: 'Invalid username or password' });

        await user.update({ isOnline: true, lastSeenAt: new Date() });

        const token = jwt.sign(
            {
                userId: user.userId,
                role: user.role,
             //   teamId: user.teamId || null,
                assignedEmpNo: user.assignedEmpNo || null,
                assignedStore: user.assignedStore ?? null,
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
                avatarUrl: user.avatarUrl || null
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
router.post('/change-password', checkRateLimit, authenticateToken, async (req, res) => {
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

        res.json({ user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch user info' });
    }
});

export default router;

