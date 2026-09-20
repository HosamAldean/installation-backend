// backend/services/reverseGeocode.js
// Turns resolved project coordinates into a real area/neighbourhood name
// via OpenStreetMap's Nominatim -- free, no API key, but its usage policy
// (https://operations.osmfoundation.org/policies/nominatim/) caps
// requests at 1/second and requires an identifying User-Agent, both
// enforced here.
const USER_AGENT = 'Petra-Installation-WebApp/1.0 (itservices@petralu.com)';
const MIN_INTERVAL_MS = 1100; // stay just under Nominatim's 1 req/sec cap

let lastRequestAt = 0;
async function throttle() {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
}

// coordinates is the "lat, lng" string this app already stores elsewhere
// (see resolveMapLink.js's extractCoords).
export async function reverseGeocodeArea(coordinates, timeoutMs = 5000) {
    const [lat, lon] = (coordinates || '').split(',').map(s => s.trim());
    if (!lat || !lon) return null;

    await throttle();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=14&addressdetails=1`;
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ar,en' },
        });
        if (!res.ok) return null;
        const body = await res.json();
        const addr = body?.address || {};
        return addr.suburb || addr.neighbourhood || addr.city_district
            || addr.town || addr.city || addr.village || null;
    } catch (err) {
        console.error('❌ REVERSE GEOCODE ERROR:', coordinates, err.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
