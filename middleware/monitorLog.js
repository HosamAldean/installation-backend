// backend/middleware/monitorLog.js
// Lightweight, append-only JSON-lines log for live-monitoring the Employee
// Gate rollout -- added specifically because there was no persistent record
// of request outcomes anywhere (morgan("dev") in index.js only writes to
// the dev server's own console, which nothing else can read after the
// fact). Logs every response with status >= 400 (errors/denials) plus
// every request to the Employee Gate surface (hr-requests, hr-reports,
// users) regardless of status, so both "what broke" and "what happened"
// are visible from one file. Deliberately just fs.appendFile, no rotation/
// external logging service -- this is a temporary rollout-watching aid,
// not permanent infrastructure.
import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "monitor.log");
fs.mkdirSync(LOG_DIR, { recursive: true });

const WATCHED_PREFIXES = ["/api/hr-requests", "/api/hr-reports", "/api/users"];

export function monitorLog(req, res, next) {
    res.on("finish", () => {
        const isError = res.statusCode >= 400;
        const isWatched = WATCHED_PREFIXES.some((p) => req.originalUrl.startsWith(p));
        if (!isError && !isWatched) return;
        const line = {
            ts: new Date().toISOString(),
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            role: req.user?.role ?? null,
            userId: req.user?.userId ?? null,
            ip: req.ip,
        };
        fs.appendFile(LOG_FILE, JSON.stringify(line) + "\n", () => {});
    });
    next();
}
