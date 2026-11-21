// backend/services/merakiClient.js
// Minimal read-only Meraki Dashboard API v1 client for the IT network page
// (services/networkMonitor.js). Needs MERAKI_API_KEY in .env -- a key made
// in Dashboard > My profile > API access, ideally for a READ-ONLY dashboard
// admin so the key can't change anything. MERAKI_ORG_ID is optional (the
// first organization the key can see is used otherwise).
//
// Every call here is a GET. Meraki allows 10 requests/s per org; we make a
// handful every few minutes, and honour 429 Retry-After anyway.

const BASE_URL = 'https://api.meraki.com/api/v1';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

export function merakiConfigured() {
    return Boolean(process.env.MERAKI_API_KEY);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The "next" URL from a Link header, if there is one.
function nextLink(header) {
    if (!header) return null;
    for (const part of header.split(',')) {
        const m = part.match(/<([^>]+)>;\s*rel=next/);
        if (m) return m[1];
    }
    return null;
}

async function request(url) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${process.env.MERAKI_API_KEY}`,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 429 && attempt < MAX_RETRIES) {
            const wait = Number(res.headers.get('retry-after')) || 2;
            await sleep(wait * 1000);
            continue;
        }
        if (!res.ok) {
            let detail = '';
            try {
                const body = await res.json();
                detail = Array.isArray(body?.errors) ? body.errors.join('; ') : '';
            } catch { /* not JSON */ }
            throw new Error(`Meraki ${res.status}${detail ? `: ${detail}` : ''} (${new URL(url).pathname})`);
        }
        return res;
    }
}

// GET a path and follow Link: rel=next pages until done (or maxPages).
export async function merakiGet(path, { maxPages = 20 } = {}) {
    let url = `${BASE_URL}${path}`;
    let out = null;
    for (let page = 0; url && page < maxPages; page++) {
        const res = await request(url);
        const body = await res.json();
        if (!Array.isArray(body)) return body;
        out = (out ?? []).concat(body);
        url = nextLink(res.headers.get('link'));
    }
    return out ?? [];
}

let cachedOrgId = null;

export async function getOrgId() {
    if (process.env.MERAKI_ORG_ID) return process.env.MERAKI_ORG_ID;
    if (cachedOrgId) return cachedOrgId;
    const orgs = await merakiGet('/organizations');
    if (!orgs.length) throw new Error('The Meraki API key cannot see any organization');
    cachedOrgId = String(orgs[0].id);
    return cachedOrgId;
}
