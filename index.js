//backend/index.js
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { sequelize, getSqlPool, sequelize2 } from "./config/db.js";
import { QueryTypes } from 'sequelize';
import { notifyOrderUpdate } from './routes/instOrders.js';
import cookieParser from 'cookie-parser';
import { monitorLog } from './middleware/monitorLog.js';
import { blockIpMiddleware } from './middleware/ipBlock.js';
import { startSecurityMonitor } from './services/securityMonitor.js';
import { LATEST_VERSION_CODE, LATEST_VERSION_NAME, MIN_SUPPORTED_VERSION_CODE, DOWNLOAD_URL, UPDATE_PAGE_URL } from './constants/mobileAppVersion.js';

// import routes
import followUpRouter from "./routes/followUp.js";
import followUpNotesRouter from "./routes/followUpNotes.js";
import scanAuditLogRouter from "./routes/scanAuditLog.js";

// import models (this triggers model definition + associations in models/index)
import './models/index.js';

// Routes
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import uploadRouter from "./routes/upload.js";
import employeeRoutes from "./routes/employees.js";
import apiRouter from "./routes/api.js";
import teamsRouter from "./routes/teams.js";
import installationRequestsRouter from "./routes/installationRequests.js";
import instOrdersRouter from "./routes/instOrders.js";
import instStepsRouter from "./routes/instSteps.js";
import mainStockRouter from "./routes/mainStock.js";
import glassRouter from "./routes/glass.js";
import stockHouseRouter from "./routes/stockHouse.js";
import projOrdersRouter from "./routes/projOrders.js";
import ironRouter from "./routes/iron.js";
import projectsRouter from "./routes/projects.js";
import clientsRouter, { archOfficesRouter } from "./routes/clients.js";
import lookupsRouter from "./routes/lookups.js";
import materialsWarehouseRouter from "./routes/materialsWarehouse.js";
import materialsWarehousePurchasingRouter from "./routes/materialsWarehousePurchasing.js";
import materialsWarehouseOperationsRouter from "./routes/materialsWarehouseOperations.js";
import materialsWarehouseCostingRouter from "./routes/materialsWarehouseCosting.js";
import materialsWarehouseReportingRouter from "./routes/materialsWarehouseReporting.js";
import materialsWarehouseCutoverRouter from "./routes/materialsWarehouseCutover.js";
import materialsWarehouseWriteoffRouter from "./routes/materialsWarehouseWriteoff.js";
import materialsWarehouseProfileStoreRouter from "./routes/materialsWarehouseProfileStore.js";
import petraErpOrdersRouter from "./routes/petraErpOrders.js";
import cashFlowRouter from "./routes/cashFlow.js";
import offersRouter from "./routes/offers.js";
import controlSheetRouter from "./routes/controlSheet.js";
import salesAnalyticsRouter from "./routes/salesAnalytics.js";
import leadsRouter from "./routes/leads.js";
import timesheetsRouter from "./routes/timesheets.js";
import cr09Router from "./routes/cr09.js";
import cr09TagsRouter from "./routes/cr09Tags.js";
import permissionsRouter from "./routes/permissions.js";
import auditRouter from "./routes/audit.js";
import announcementsRouter from "./routes/announcements.js";
import hrRequestsRouter from "./routes/hrRequests.js";
import payslipRouter from "./routes/payslip.js";
import hrReportsRouter from "./routes/hrReports.js";
import ittihadAttendanceRouter from "./routes/ittihadAttendance.js";
 // follow-up module

// Models (named imports)
import {
    InstTeamCheckpoints,
    InstOrderStepUpdates,
    InstOrderHolds
} from "./models/index.js"; // ✅ Use named imports, not default

dotenv.config();

const app = express();

// ======================
// File paths
// ======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======================
// Security
// ======================
app.use(helmet({crossOriginResourcePolicy: false,}));

// ======================
// CORS
// ======================
const staticAllowedOrigins = [
    'https://localhost:5173',
    'https://192.168.20.77:5173',
    'http://localhost:5173',
    'http://192.168.20.77:5173',
    'https://petralu.duckdns.org:5173',
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true); // non-browser clients (mobile app, curl, etc.)
        if (staticAllowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
}));


// ======================
// Body parsers
// ======================
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());
// ======================
// Logging
// ======================
app.use(morgan("dev"));
app.use(monitorLog);

// ======================
// IP blocklist -- admin-managed, see routes/audit.js's /blocked-ips
// endpoints. Placed after monitorLog (so a blocked request still shows up
// in the log/Unauthorized-Access-adjacent tooling) but before every
// static file and API route, so a blocked IP can't reach anything.
// ======================
app.use(blockIpMiddleware);

// ======================
// UTF-8 JSON responses
// ======================
/*app.use((req, res, next) => {
    const oldJson = res.json;
    res.json = function (data) {
        if (!res.headersSent) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        return oldJson.call(this, data);
    };
    next();
});*/

// ======================
// Serve uploaded files
// ======================
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
// Sideload-only distribution for mobile/ (no OTA/Play Store, see
// constants/mobileAppVersion.js) -- always overwrite this same filename
// when cutting a new release so the in-app "Update" link never needs to
// change across versions.
app.use('/downloads', express.static(path.join(process.cwd(), 'public/downloads')));
// ======================
// API Routes
// ======================
app.use("/api/follow-up", followUpRouter); // follow-up
app.use("/api/follow-up-notes", followUpNotesRouter); // manager/PM follow-up notes tracker
app.use("/api/scan-audit-log", scanAuditLogRouter); // server-persisted warehouse scan history

// ======================
// Health check
// ======================

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Public (no auth) so a not-yet-logged-in mobile client can check too --
// see constants/mobileAppVersion.js for the update-vs-hard-block cutoff.
// downloadUrl points at the friendly /update page (below), not the raw
// .apk, so anyone opening this link outside the app (push notification,
// a message from IT) lands somewhere that explains what's happening.
app.get('/api/app-version', (req, res) => res.json({
    success: true,
    latestVersionCode: LATEST_VERSION_CODE,
    latestVersionName: LATEST_VERSION_NAME,
    minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE,
    downloadUrl: UPDATE_PAGE_URL,
}));

// Friendly landing page for the update link people actually tap (push
// notification, login-rejection message) -- visiting the raw .apk URL
// directly gives a browser nothing to render (confirmed live: Chrome just
// silently starts a binary download, no page, no version, no next step).
// Self-contained (no external CSS/JS/fonts) so it works under the
// existing strict CSP with zero extra allowances.
app.get('/update', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Petra Mobile</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#f3f5f9; margin:0; padding:0; color:#1a2233; }
  .wrap { max-width: 420px; margin: 0 auto; padding: 40px 24px; text-align:center; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  p { font-size: 15px; line-height: 1.5; color:#4b5568; }
  .btn { display:inline-block; margin-top:24px; background:#2563eb; color:#fff; text-decoration:none; font-weight:700; padding:14px 32px; border-radius:10px; font-size:16px; }
  .version { color:#8892a6; font-size:13px; margin-top:10px; }
  .steps { text-align:left; margin-top:32px; background:#fff; border-radius:12px; padding:20px 24px; font-size:14px; color:#4b5568; }
  .steps li { margin-bottom:8px; }
  .ar { direction: rtl; margin-top: 40px; border-top: 1px solid #e2e5ec; padding-top: 32px; }
  .ar .steps { text-align: right; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Petra Mobile</h1>
    <p>Get the Petra Mobile app for field ops and HR self-service — or update it if you already have it installed.</p>
    <a class="btn" href="${DOWNLOAD_URL}">Download v${LATEST_VERSION_NAME}</a>
    <div class="version">Version ${LATEST_VERSION_NAME}</div>
    <p><strong>What's new:</strong> Payslip (view your monthly salary breakdown, when enabled by HR).</p>
    <ol class="steps">
      <li>Tap "Download" above.</li>
      <li>Open the downloaded file from your notifications or Downloads folder.</li>
      <li>If asked, allow installing apps from this source.</li>
      <li>Tap Install, then open the app and log in.</li>
    </ol>
    <div class="ar">
      <h1>تطبيق بترا موبايل</h1>
      <p>حمّل تطبيق بترا موبايل للعمل الميداني والخدمة الذاتية للموارد البشرية — أو حدّثه إذا كان مثبتًا لديك بالفعل.</p>
      <a class="btn" href="${DOWNLOAD_URL}">تحميل الإصدار ${LATEST_VERSION_NAME}</a>
      <p><strong>الجديد في هذا الإصدار:</strong> قسيمة الراتب (عرض تفاصيل راتبك الشهري، عند تفعيلها من قبل الموارد البشرية).</p>
      <ol class="steps">
        <li>اضغط على زر "تحميل" أعلاه.</li>
        <li>افتح الملف الذي تم تحميله من الإشعارات أو مجلد التنزيلات.</li>
        <li>إذا طُلب منك ذلك، اسمح بتثبيت التطبيقات من هذا المصدر.</li>
        <li>اضغط تثبيت، ثم افتح التطبيق وسجل الدخول.</li>
      </ol>
    </div>
  </div>
</body>
</html>`);
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/employees", employeeRoutes);
app.use("/api/upload", uploadRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/installation-requests", installationRequestsRouter);
app.use("/api/instOrders", instOrdersRouter);
app.use("/api/instSteps", instStepsRouter);
app.use("/api/main-stock", mainStockRouter);
app.use("/api/glass", glassRouter);
app.use("/api/stock-house", stockHouseRouter);
app.use("/api/proj-orders", projOrdersRouter);
app.use("/api/iron", ironRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/clients", clientsRouter);
app.use("/api/arch-offices", archOfficesRouter);
app.use("/api/lookups", lookupsRouter);
app.use("/api/materials-warehouse", materialsWarehouseRouter);
app.use("/api/materials-warehouse", materialsWarehousePurchasingRouter);
app.use("/api/materials-warehouse", materialsWarehouseOperationsRouter);
app.use("/api/materials-warehouse", materialsWarehouseCostingRouter);
app.use("/api/materials-warehouse", materialsWarehouseReportingRouter);
app.use("/api/materials-warehouse", materialsWarehouseCutoverRouter);
app.use("/api/materials-warehouse", materialsWarehouseWriteoffRouter);
app.use("/api/materials-warehouse/profile-store", materialsWarehouseProfileStoreRouter);
app.use("/api/petra-erp/orders", petraErpOrdersRouter);
app.use("/api/cash-flow", cashFlowRouter);
app.use("/api/offers", offersRouter);
app.use("/api/control-sheets", controlSheetRouter);
app.use("/api/sales-analytics", salesAnalyticsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/timesheets", timesheetsRouter);
app.use("/api/cr09", cr09Router);
app.use("/api/admin/permissions", permissionsRouter);
app.use("/api/admin/audit", auditRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/cr09/tags", cr09TagsRouter);
app.use("/api/hr-requests", hrRequestsRouter);
app.use("/api/payslip", payslipRouter);
app.use("/api/hr-reports", hrReportsRouter);
app.use("/api/ittihad-attendance", ittihadAttendanceRouter);

app.use("/api", apiRouter);
app.use('/instOrders', instOrdersRouter);

// ======================
// Test DB connections
// ======================
/*app.get("/api/test-connections", async (req, res) => {
    try {
        await sequelize.authenticate();

        const pools = {
            erp: await getSqlPool("erp"),
            proj: await getSqlPool("proj"),
            stock: await getSqlPool("stockhouse"),
            glass: await getSqlPool("glass"),
        };

        await Promise.all([
            pools.erp.request().query("SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES"),
            pools.proj.request().query("SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES"),
            pools.stock.request().query("SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES"),
            pools.glass.request().query("SELECT TOP 1 * FROM INFORMATION_SCHEMA.TABLES"),
        ]);

        res.json({
            mysql: "✅ Connected to MySQL",
            erp: "✅ Connected to ERP",
            proj: "✅ Connected to Proj",
            stock: "✅ Connected to StockHouse",
            glass: "✅ Connected to Glass",
        });
    } catch (err) {
        console.error("❌ Connection error:", err);
        res.status(500).json({ error: err.message });
    }
});
*/
// ======================
// Global error handler
// ======================
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err);
    if (!res.headersSent) {
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

// ======================
// Start server (HTTPS)
// ======================

import fs from "fs";
import https from "https";
import http from "http";
import tls from "tls";

(async () => {
    try {
        await sequelize.authenticate();
        console.log("✅ MySQL connected successfully.");

        const PORT = process.env.PORT || 4000;

        // SSL Certificates (mkcert) -- used for LAN/localhost access, where
        // the mkcert root CA is trusted on this dev machine only.
        const sslOptions = {
            key: fs.readFileSync(path.join(process.cwd(), "localhost+1-key.pem")),
            cert: fs.readFileSync(path.join(process.cwd(), "localhost+1.pem")),
        };

        // Real, publicly-trusted cert (Let's Encrypt via win-acme + DuckDNS)
        // for the public hostname -- mobile devices and browsers off this
        // machine don't trust the mkcert CA at all, so the public-facing
        // domain needs its own real cert. Selected via SNI so both certs
        // can be served from the same port depending on which hostname the
        // client actually requested.
        const duckDnsCertDir = path.join(process.cwd(), "certs", "duckdns");
        let duckDnsSecureContext = null;
        try {
            duckDnsSecureContext = tls.createSecureContext({
                key: fs.readFileSync(path.join(duckDnsCertDir, "petralu.duckdns.org-key.pem")),
                cert: fs.readFileSync(path.join(duckDnsCertDir, "petralu.duckdns.org-chain.pem")),
            });
        } catch (err) {
            console.warn("⚠️  DuckDNS certificate not loaded, falling back to mkcert for all hosts:", err.message);
        }
        if (duckDnsSecureContext) {
            sslOptions.SNICallback = (servername, cb) => {
                if (servername === "petralu.duckdns.org") {
                    cb(null, duckDnsSecureContext);
                } else {
                    cb(null, tls.createSecureContext(sslOptions));
                }
            };
        }

        // HTTPS Server
        // .listen() binds asynchronously -- a failure (EADDRINUSE from the
        // previous nodemon-restarted process not having released the port
        // yet, EACCES, etc.) surfaces as an 'error' event on the server
        // object, not a thrown exception the surrounding try/catch would
        // ever see. Unhandled, Node's default EventEmitter behavior is to
        // throw and crash the whole process with no logged cause -- which
        // is exactly what nodemon's silent "app crashed" reports when this
        // isn't listened for. Logging it here at least makes the failure
        // diagnosable instead of an invisible crash.
        https.createServer(sslOptions, app)
            .on("error", (err) => {
                console.error(`❌ HTTPS server failed to start on port ${PORT}:`, err.message);
            })
            .listen(PORT, "0.0.0.0", () => {
                console.log(`🔥 HTTPS Backend running on https://192.168.20.77:${PORT}`);
            });

        // Optional: HTTP redirect → HTTPS
        http.createServer((req, res) => {
            res.writeHead(301, {
                Location: `https://${req.headers.host.replace(/:\d+/, ":" + PORT)}${req.url}`
            });
            res.end();
        })
            .on("error", (err) => {
                console.error("❌ HTTP redirect server failed to start on port 4001:", err.message);
            })
            .listen(4001, "0.0.0.0", () => {
                console.log("➡ HTTP redirect server on :4001 → HTTPS");
            });

        // Start DB watcher to emit SSE when relevant tables change
        try {
            let last = { checkpoints: 0, steps: 0, locations: 0, components: 0 };
            const poll = async () => {
                try {
                    const cp = await sequelize2.query(
                        `SELECT UNIX_TIMESTAMP(MAX(IFNULL(createdAt, created_at))) AS t FROM IIT_Petra.instTeamCheckpoints`,
                        { type: QueryTypes.SELECT }
                    );
                    const st = await sequelize2.query(
                        `SELECT UNIX_TIMESTAMP(MAX(updatedAt)) AS t FROM IIT_Petra.instOrderSteps`,
                        { type: QueryTypes.SELECT }
                    );
                    const loc = await sequelize2.query(
                        `SELECT UNIX_TIMESTAMP(MAX(ping_time)) AS t FROM IIT_Petra.instTeamLocations`,
                        { type: QueryTypes.SELECT }
                    );
                    // Component tracking's own equivalent of instOrderSteps --
                    // without this, a change to InstOrderComponents from
                    // outside the confirm/report-issue/mark-complete API
                    // handlers (which already call notifyOrderUpdate directly)
                    // would never trigger a live refresh, unlike the old
                    // step model.
                    const comp = await sequelize2.query(
                        `SELECT UNIX_TIMESTAMP(MAX(updatedAt)) AS t FROM IIT_Petra.InstOrderComponents`,
                        { type: QueryTypes.SELECT }
                    );

                    const t1 = Number(cp[0].t || 0);
                    const t2 = Number(st[0].t || 0);
                    const t3 = Number(loc[0].t || 0);
                    const t4 = Number(comp[0].t || 0);

                    if (t1 && t1 !== last.checkpoints) {
                        last.checkpoints = t1;
                        try { notifyOrderUpdate({ event: 'update', source: 'db', table: 'instTeamCheckpoints', time: new Date().toISOString() }); } catch (e) {}
                    }
                    if (t2 && t2 !== last.steps) {
                        last.steps = t2;
                        try { notifyOrderUpdate({ event: 'update', source: 'db', table: 'instOrderSteps', time: new Date().toISOString() }); } catch (e) {}
                    }
                    if (t3 && t3 !== last.locations) {
                        last.locations = t3;
                        try { notifyOrderUpdate({ event: 'update', source: 'db', table: 'instTeamLocations', time: new Date().toISOString() }); } catch (e) {}
                    }
                    if (t4 && t4 !== last.components) {
                        last.components = t4;
                        try { notifyOrderUpdate({ event: 'update', source: 'db', table: 'InstOrderComponents', time: new Date().toISOString() }); } catch (e) {}
                    }
                } catch (err) {
                    // ignore polling errors
                }
            };

            setInterval(poll, 3000);
        } catch (e) {
            console.error('DB watcher failed to start', e);
        }

    } catch (err) {
        console.error("❌ DB connection failed:", err);
        process.exit(1);
    }

    // Sync models only in dev
    if (process.env.NODE_ENV !== "production") {
        await sequelize.sync();
        console.log("✅ Models synced");
    }

    startSecurityMonitor();
})();

