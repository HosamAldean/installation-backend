// backend/utils/unauthorizedAccessLog.js
// Fire-and-forget logger for 403s, called from middleware/auth.js and
// middleware/permissions.js's authorization chokepoints. Never awaited by
// callers and never throws -- a logging failure must not affect the
// actual (already-decided) 403 response, same reasoning as routes/
// auth.js's recordLoginAudit.
import { UnauthorizedAccessAudit } from '../models/UnauthorizedAccessAudit.js';

export function recordUnauthorizedAccess({ userId, role, method, path, requiredAccess, ip }) {
    UnauthorizedAccessAudit.create({
        userId: userId ?? null,
        role: role ?? null,
        method,
        path,
        requiredAccess: requiredAccess ?? null,
        ip: ip ?? null,
    }).catch((err) => {
        console.error('❌ Failed to record unauthorized access:', err);
    });
}
