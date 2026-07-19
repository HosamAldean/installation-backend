// ------------------------------------------------------
// backend/scripts/create-item-profile-table.js
// ------------------------------------------------------
// Creates guest.ItemProfile on the StockHouse SQL Server database — the
// backing table for the Material Store "Item Profiles" catalog
// (routes/stockHouse.js's /item-profiles endpoints, frontend
// src/pages/admin/ItemProfiles.tsx).
//
// This table has no legacy Access equivalent: confirmed during the 2026-07
// integration work that dbo.ProfileNo is a read-only view over transaction
// history, not an editable profile-name master table, so this is a
// genuinely new table rather than a port of an existing one.
//
// It was originally created directly against the live database via a
// one-off script during that session — this file exists so the schema is
// reproducible (new environment, staging, disaster recovery) instead of
// only existing as a fact someone has to remember. Safe to re-run: it
// checks for the table first and does nothing if it already exists.
import { getSqlPool } from "../config/db.js";

const run = async () => {
    try {
        const pool = await getSqlPool("stockhouse");

        const exists = await pool.request().query(`
            SELECT 1 FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = 'guest' AND TABLE_NAME = 'ItemProfile'
        `);
        if (exists.recordset.length > 0) {
            console.log("guest.ItemProfile already exists — nothing to do.");
            process.exit(0);
        }

        await pool.request().query(`
            CREATE TABLE guest.ItemProfile (
                ID INT IDENTITY(1,1) PRIMARY KEY,
                ProfileNO NVARCHAR(50) NOT NULL,
                ProfileName NVARCHAR(100) NOT NULL,
                Details NVARCHAR(MAX) NULL,
                PhotoUrl NVARCHAR(255) NULL,
                SUser NVARCHAR(50) NULL,
                SDate DATETIME NULL
            )
        `);
        console.log("Created guest.ItemProfile.");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

run();
