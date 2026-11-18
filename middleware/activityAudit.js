// backend/middleware/activityAudit.js
// Records every data-changing request (POST/PUT/PATCH/DELETE) by a signed-in
// user into ActivityAudits (see that model for why). Mounted once in
// index.js before the routers: it only registers a res 'finish' listener,
// and by the time the response finishes the router's authenticateToken has
// set req.user on the same request object.
//
// Writes are buffered and flushed in one bulk insert every few seconds, so
// a busy minute costs a handful of queries instead of one per request, and
// a slow/failed audit insert can never delay or break the real request.
import { ActivityAudit } from '../models/ActivityAudit.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// High-volume or already-audited endpoints. Location pings arrive every few
// minutes from every phone; logins have LoginAudits; push-token and
// heartbeat calls are housekeeping, not user actions.
const SKIP_PATTERNS = [
    /^\/api\/follow-up\/location\b/,
    /^\/api\/auth\/(login|logout|push-token)\b/,
    /^\/api\/sse\b/,
];

const SECRET_KEY = /pass(word)?|pwd|token|secret|otp|pin\b|cookie|authorization|apikey|api_key|signature/i;
const MAX_STRING = 300;
const MAX_JSON = 6000;
const MAX_ARRAY = 50;

function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
    if (typeof value !== 'object') return value;
    if (depth > 5) return '[…]';
    if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
        if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
        return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
}

function toJson(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null;
    let s;
    try { s = JSON.stringify(value); } catch { return null; }
    return s.length > MAX_JSON ? s.slice(0, MAX_JSON) + '…' : s;
}

// Multer puts uploads on req.file / req.files -- keep names and sizes only.
function describeFiles(req) {
    const list = [];
    const add = (f) => f && list.push({ field: f.fieldname, name: f.originalname, size: f.size, type: f.mimetype });
    add(req.file);
    if (Array.isArray(req.files)) req.files.forEach(add);
    else if (req.files && typeof req.files === 'object') Object.values(req.files).flat().forEach(add);
    return list.length ? list : undefined;
}

// /api/materials-warehouse/... -> materials-warehouse. Grouping prefixes
// (/api/admin/permissions, /api/petra-erp/orders) keep their second part.
const GROUP_PREFIXES = new Set(['admin', 'petra-erp']);
export function moduleFromPath(path) {
    const m = /^\/api\/([^/?#]+)(?:\/([^/?#]+))?/.exec(path);
    if (!m) return null;
    const first = m[1].toLowerCase();
    const mod = GROUP_PREFIXES.has(first) && m[2] && !/^\d+$/.test(m[2]) ? `${first}-${m[2].toLowerCase()}` : first;
    return mod.slice(0, 64);
}

function platformOf(req) {
    const ua = String(req.headers['user-agent'] || '');
    if (req.headers['x-app-version-code'] || /okhttp|expo|dalvik|cfnetwork/i.test(ua)) return 'mobile';
    return ua ? 'web' : null;
}

let buffer = [];
let flushing = false;
const FLUSH_MS = 3000;
const MAX_BUFFER = 2000;

async function flush() {
    if (flushing || !buffer.length) return;
    flushing = true;
    const rows = buffer;
    buffer = [];
    try {
        await ActivityAudit.bulkCreate(rows);
    } catch (err) {
        console.error('❌ Activity audit flush failed:', err.message);
        // Keep the rows for the next try, but never grow without bound if
        // the table is unreachable for a long time.
        buffer = rows.concat(buffer).slice(-MAX_BUFFER);
    } finally {
        flushing = false;
    }
}
setInterval(flush, FLUSH_MS).unref();

export function activityAudit(req, res, next) {
    if (!WRITE_METHODS.has(req.method)) return next();
    const start = Date.now();
    res.on('finish', () => {
        try {
            const user = req.user;
            if (!user?.userId) return; // anonymous / rejected before auth
            const path = (req.originalUrl || req.url || '').split('?')[0];
            if (SKIP_PATTERNS.some((re) => re.test(path))) return;
            const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : null;
            const files = describeFiles(req);
            const body = req.body && typeof req.body === 'object' ? redact(req.body) : undefined;
            const params = { ...(req.params || {}), ...(Object.keys(req.query || {}).length ? { query: redact(req.query) } : {}) };
            buffer.push({
                userId: user.userId,
                username: null, // req.user has no username; resolved when read
                role: user.role ? String(user.role).slice(0, 50) : null,
                method: req.method,
                route: route ? route.slice(0, 255) : null,
                path: path.slice(0, 500),
                module: moduleFromPath(path),
                status: res.statusCode,
                platform: platformOf(req),
                ip: req.ip ? String(req.ip).slice(0, 64) : null,
                params: toJson(params),
                body: toJson(files ? { ...(body || {}), _files: files } : body),
                durationMs: Date.now() - start,
            });
            if (buffer.length >= MAX_BUFFER) flush();
        } catch (err) {
            console.error('❌ Activity audit capture failed:', err.message);
        }
    });
    next();
}

// Creates the table on first start (CREATE TABLE IF NOT EXISTS -- never
// alters an existing one). Production doesn't run sequelize.sync().
export async function ensureActivityAuditTable() {
    try {
        await ActivityAudit.sync();
    } catch (err) {
        console.error('❌ ActivityAudits table check failed:', err.message);
    }
}
