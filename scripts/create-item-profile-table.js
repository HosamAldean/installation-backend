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
//
// --- Backfill history (2026-07-20) ---------------------------------------
// The table started empty (this feature has no legacy predecessor to port
// data from — see above). Backfilled from dbo.ProfileNo, the read-only
// view over real transaction history, via one-off throwaway scripts run
// directly against the live DB (not checked in — see git history / session
// notes if the exact queries are ever needed again):
//
// 1. Initial import (2,618 rows): every distinct ProfileNO from
//    dbo.ProfileNo with (a) exactly one ProfileName across all its rows —
//    no ambiguity — and (b) at least one digit in ProfileNO, to filter out
//    obvious free-text placeholders typed into that field instead of a
//    real code.
// 2. Contamination found and removed (649 rows) while building the
//    Computer Numbers feature: the "contains a digit" filter above wasn't
//    strict enough — it let full descriptions/dimension strings through
//    (e.g. "Zinc-227*1344", "1219.2*1740*1.88") since they happened to
//    contain digits. Removed anything not shaped like a real code (mostly
//    digits, optionally one short trailing marker like "*").
// 3. Conflict resolution on the profiles with >1 candidate ProfileName
//    (137 in the original pass): re-checked using SQL Server's actual
//    case-insensitive ProfileNO collation (an earlier case-sensitive JS
//    grouping had wrongly split some case-variant numbers — e.g.
//    "eblgla-03"/"EBLGLA-03" — into fake single-candidate "winners").
//    Correctly grouped, only 1 profile (62211) had a real frequency
//    majority; 3 more were whitespace-only duplicates (e.g. "بلاستيك" vs
//    " بلاستيك") with no real naming conflict. All 4 resolved and
//    imported. The remaining 108 are genuine ties — multiple different
//    names, each used exactly once, no statistical basis to pick — and
//    123 profiles are non-numeric "codes" that aren't real identifiers.
//    Both groups were deliberately left out of the catalog rather than
//    guessed at; add them by hand via the admin UI if/when someone who
//    knows the physical inventory can resolve them.
//
// Final count after all of the above: 1,973 rows.
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
