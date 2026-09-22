// backend/utils/dateOnly.js
// `value` can arrive as either a plain "YYYY-MM-DD"(-ish) string (from
// req.body, e.g. POST /instOrders/create's scheduled_date) or a native JS
// Date object (from a raw SQL SELECT of a DATE/DATETIME column) -- mysql2
// returns date columns as real Date objects, not strings.
// String(aDateObject) runs it through Date.prototype.toString(), which
// starts "Sun Jul 26 2026 ..." with NO leading year, so slice(0, 10) alone
// silently produces garbage like "Sun Jul 26" for a Date input (confirmed
// live: this exact bug corrupted the first backfill run of
// InstOrderScheduleDays). Extracted via local Y/M/D components for a Date
// -- not toISOString(), which shifts to UTC and is the same day-shift bug
// already worked around in frontend/src/pages/schedule.tsx's own
// todayStr() -- while a string is trusted as already being in that format
// and just takes its first 10 characters.
export function toDateOnlyString(value) {
    if (value instanceof Date) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}
