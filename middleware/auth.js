// backend/middleware/auth.js
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

// Authenticate JWT from cookie or header
export const authenticateToken = (req, res, next) => {
    try {
        // EventSource (used for the SSE order-updates stream) can't set a
        // custom Authorization header or reliably send cross-origin cookies
        // in dev, so it passes the token as a query param instead — the only
        // caller that does this is useOrderStream.ts.
        const token =
            req.cookies?.accessToken ||
            req.headers.authorization?.split(' ')[1] ||
            req.query?.token;
        if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

        const payload = jwt.verify(token, process.env.JWT_SECRET);

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
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

// Role-based authorization
export const authorizeRoles = (...roles) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
};
