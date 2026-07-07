// backend/config/db.js
import { Sequelize } from 'sequelize';
import sql from 'mssql';
import dotenv from 'dotenv';
dotenv.config();

// ======================
// MySQL (main)
// ======================
export const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host: process.env.DB_HOST,
        dialect: 'mysql',
        logging: false,
        dialectOptions: {
            charset: 'latin1',
            collate: 'latin1_swedish_ci',
            typeCast(field, next) {
                if (field.type === "STRING" || field.type === "BLOB") {
                    const value = field.string();
                    if (value == null) return null;
                    return Buffer.from(value, "binary").toString("utf8");
                }
                return next();
            },
        },
        define: {
            charset: 'latin1',
            collate: 'latin1_swedish_ci',
        },
    }
);

// ======================
// MySQL (secondary)
// ======================
export const sequelize2 = new Sequelize(
    process.env.DB_NAME || 'IIT_Petra',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || '',
    {
        host: process.env.DB_HOST || '127.0.0.1',
        dialect: 'mysql',
        port: Number(process.env.DB_PORT || 3306),
        logging: false,
        define: {
            timestamps: false // we'll set timestamps per model where needed
        }
    }
);

// Dedicated connection for newer, non-legacy tables (e.g. FollowUpNotes)
// that should just store/return correct UTF-8 without the latin1
// raw-byte-passthrough convention the rest of this file relies on for
// legacy data — sequelize2 has no explicit client charset, which means it
// falls back to the MySQL server's default (latin1 on this server), silently
// replacing non-latin1 characters with '?' on write instead of round-tripping
// them correctly.
export const sequelizeUtf8 = new Sequelize(
    process.env.DB_NAME || 'IIT_Petra',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || '',
    {
        host: process.env.DB_HOST || '127.0.0.1',
        dialect: 'mysql',
        port: Number(process.env.DB_PORT || 3306),
        logging: false,
        dialectOptions: {
            charset: 'utf8mb4',
        },
        define: {
            timestamps: false,
            charset: 'utf8mb4',
        },
    }
);

export const sequelize3 = new Sequelize(
    process.env.DB_NAME || 'IIT_Petra',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || '',
    {
        host: process.env.DB_HOST || '127.0.0.1',
        dialect: 'mysql',
        port: Number(process.env.DB_PORT || 3306),
        logging: false,
        dialectOptions: {
            charset: 'latin1',
            collate: 'latin1_swedish_ci',
            typeCast(field, next) {
                if (field.type === "STRING" || field.type === "BLOB") {
                    const value = field.string();
                    if (value == null) return null;
                    return Buffer.from(value, "binary").toString("utf8");
                }
                return next();
            },
        },
        define: {
            timestamps: false,
            charset: 'latin1',
            collate: 'latin1_swedish_ci'
        }
    }
);

// ======================
// SQL Server connections
// ======================
const sqlServers = {
    erp: {
        user: process.env.MSSQL1_USER,
        password: process.env.MSSQL1_PASS,
        server: process.env.MSSQL1_SERVER,
        database: process.env.MSSQL1_DB,
        options: { encrypt: false, trustServerCertificate: true },
    },
    proj: {
        user: process.env.MSSQL2_USER,
        password: process.env.MSSQL2_PASS,
        server: `${process.env.MSSQL2_SERVER}\\ACCESPROJ`,
        database: process.env.MSSQL2_PROJ_DB,
        options: { encrypt: false, trustServerCertificate: true },
    },
    stockhouse: {
        user: process.env.MSSQL2_USER,
        password: process.env.MSSQL2_PASS,
        server: `${process.env.MSSQL2_SERVER}\\ACCESPROJ`,
        database: process.env.MSSQL2_STOCK_DB,
        options: { encrypt: false, trustServerCertificate: true },
    },
    glass: {
        user: process.env.MSSQL2_USER,
        password: process.env.MSSQL2_PASS,
        server: `${process.env.MSSQL2_SERVER}\\ACCESPROJ`,
        database: process.env.MSSQL2_GLASS_DB,
        options: { encrypt: false, trustServerCertificate: true },
    },
    minstock: {
        user: process.env.MSSQL2_USER,
        password: process.env.MSSQL2_PASS,
        server: `${process.env.MSSQL2_SERVER}\\ACCESPROJ`,
        database: process.env.MSSQL2_MinStock_DB,
        options: { encrypt: false, trustServerCertificate: true },
    },
};

// ======================
// Utility function to connect to the right SQL Server
// ======================
// Was creating (and never closing) a brand-new ConnectionPool — and doing a
// fresh TCP+TLS+login handshake — on every single call. Under concurrent
// request load this intermittently failed outright (confirmed live: ~1 in 5
// requests to a Glass endpoint 500'd with a generic "failed to fetch"), on
// top of leaking a socket per call forever. mssql's ConnectionPool already
// pools individual connections internally — the fix is to keep one long-
// lived pool per server and reuse it, the same way sequelize/sequelize2/
// sequelize3 above are each a single module-scoped instance rather than
// being re-created per request.
const sqlPoolPromises = new Map(); // serverKey -> Promise<ConnectionPool>

export async function getSqlPool(serverKey = 'proj') {
    const config = sqlServers[serverKey];
    if (!config) throw new Error(`Unknown SQL Server key: ${serverKey}`);

    const cached = sqlPoolPromises.get(serverKey);
    if (cached) {
        const pool = await cached;
        if (pool.connected) return pool;
        // Pool was closed/dropped after a fatal error — fall through and
        // establish a fresh one below instead of handing back a dead pool.
        sqlPoolPromises.delete(serverKey);
    }

    const connecting = (async () => {
        const pool = new sql.ConnectionPool(config);
        // A fatal error on the pool (e.g. the server closing every
        // connection at once) doesn't necessarily flip `.connected` to
        // false on its own — drop it from the cache so the next call
        // reconnects instead of reusing a pool stuck in a broken state.
        pool.on('error', (err) => {
            console.error(`❌ SQL Server pool error (${serverKey}):`, err);
            sqlPoolPromises.delete(serverKey);
        });
        await pool.connect();
        return pool;
    })();

    // Cache the in-flight promise itself (not just the resolved pool) so
    // concurrent callers during the initial connect race onto the same
    // connection attempt instead of each opening their own.
    sqlPoolPromises.set(serverKey, connecting);
    try {
        return await connecting;
    } catch (err) {
        sqlPoolPromises.delete(serverKey); // don't cache a failed attempt
        throw err;
    }
}
