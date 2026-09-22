// backend/utils/concurrency.js
// Runs `mapper` over `items` with at most `limit` in flight at once. Added
// after GET /instOrders/assigned-components started 500ing under real load
// (confirmed live: Promise.all over ~2100 instOrderItems fired that many
// concurrent SQL Server + MySQL requests per call, exceeding the mssql
// pool's default max of 10 and blowing up the whole request on the first
// pool-acquire timeout) -- use this instead of a bare Promise.all whenever
// mapping over a DB-backed list whose size isn't bounded by pagination.
export async function mapWithConcurrencyLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await mapper(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
