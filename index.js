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

// import routes
import followUpRouter from "./routes/followUp.js";
import followUpNotesRouter from "./routes/followUpNotes.js";

// import models (this triggers model definition + associations in models/index)
import './models/index.js';

// Routes
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import itemsRouter from "./routes/items.js";
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
];
// Dev-tunnel URLs (VS Code Ports panel / devtunnels.ms) are dynamically
// generated per session, so they're matched by pattern instead of being
// hardcoded here.
const devTunnelOriginPattern = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.devtunnels\.ms$/i;

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true); // non-browser clients (mobile app, curl, etc.)
        if (staticAllowedOrigins.includes(origin) || devTunnelOriginPattern.test(origin)) {
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
// ======================
// API Routes
// ======================
app.use("/api/follow-up", followUpRouter); // follow-up
app.use("/api/follow-up-notes", followUpNotesRouter); // manager/PM follow-up notes tracker

// ======================
// Health check
// ======================

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/items", itemsRouter);
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

(async () => {
    try {
        await sequelize.authenticate();
        console.log("✅ MySQL connected successfully.");

        const PORT = process.env.PORT || 4000;

        // SSL Certificates (mkcert)
        const sslOptions = {
            key: fs.readFileSync(path.join(process.cwd(), "localhost+1-key.pem")),
            cert: fs.readFileSync(path.join(process.cwd(), "localhost+1.pem")),
        };

        // HTTPS Server
        https.createServer(sslOptions, app).listen(PORT, "0.0.0.0", () => {
            console.log(`🔥 HTTPS Backend running on https://192.168.20.77:${PORT}`);
        });

        // Optional: HTTP redirect → HTTPS
        http.createServer((req, res) => {
            res.writeHead(301, {
                Location: `https://${req.headers.host.replace(/:\d+/, ":" + PORT)}${req.url}`
            });
            res.end();
        }).listen(4001, "0.0.0.0", () => {
            console.log("➡ HTTP redirect server on :4001 → HTTPS");
        });

        // Start DB watcher to emit SSE when relevant tables change
        try {
            let last = { checkpoints: 0, steps: 0, locations: 0 };
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

                    const t1 = Number(cp[0].t || 0);
                    const t2 = Number(st[0].t || 0);
                    const t3 = Number(loc[0].t || 0);

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
})();

