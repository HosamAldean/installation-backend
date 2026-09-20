// backend/services/resolveMapLink.js
// Follows a shortened Google Maps link (maps.app.goo.gl, goo.gl/maps) to
// its real destination URL and pulls the embedded lat/lng out of it.
// Confirmed live: https://maps.app.goo.gl/RGVrXphMLwfgzCKj9 redirects to
// .../@31.9873917,35.799444,16z -- a plain HTTP redirect, not a paid
// geocoding API call, so no key/quota involved.
const SHORT_LINK_RE = /goo\.gl|maps\.app/i;
const COORDS_RE = /@(-?\d+\.\d+),(-?\d+\.\d+)/;
// The segment right after /maps/place/ -- present whenever the link came
// from someone searching/picking a named place rather than dropping a bare
// pin. No geocoding call needed, it's already sitting in the URL text.
const PLACE_SEGMENT_RE = /\/maps\/place\/([^/@]+)\//;

export function isShortMapLink(url) {
    return !!url && SHORT_LINK_RE.test(url);
}

export function extractCoords(url) {
    const match = url?.match(COORDS_RE);
    return match ? `${match[1]}, ${match[2]}` : null;
}

// Only meaningful for links that embed an actual place name -- a bare
// coordinate pin's "place" segment is either absent (URL goes straight to
// @lat,lng) or a DMS string like `31°59'14.4"N+35°48'03.5"E`, which this
// rejects (degree symbol, or starts with a digit) rather than surfacing as
// a fake "name".
export function extractPlaceName(url) {
    const match = url?.match(PLACE_SEGMENT_RE);
    if (!match) return null;
    let name;
    try {
        name = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
    } catch {
        return null;
    }
    if (!name || /^-?\d/.test(name) || name.includes('°')) return null;
    return name;
}

// Resolves via a real network call -- keep the timeout short so one dead
// link can't stall the whole team-roster response.
export async function resolveShortMapLink(url, timeoutMs = 4000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
        return { coordinates: extractCoords(res.url), placeName: extractPlaceName(res.url) };
    } catch (err) {
        console.error('❌ RESOLVE MAP LINK ERROR:', url, err.message);
        return { coordinates: null, placeName: null };
    } finally {
        clearTimeout(timeout);
    }
}
