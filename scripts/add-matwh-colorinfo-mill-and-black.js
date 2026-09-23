// ------------------------------------------------------
// backend/scripts/add-matwh-colorinfo-mill-and-black.js
// ------------------------------------------------------
// Adds two new AL-type rows to the SHARED IIT_Petra.colorInfo table (used
// elsewhere in Petra for coating/CR09, not owned by Materials Warehouse --
// see materialsWarehouseOperations.js's GET /color-lookup, which reads
// this same table filtered to colorType.colorTypeName='AL'), per direct
// user request 2026-09-23:
//   - MILL: makes mill-finish/raw aluminum an explicitly selectable color
//     on a reservation line, instead of only ever being an implicit system
//     concept (color: null on the ledger, only ever reached today via a
//     painted-color shortfall's auto-coating-routing -- see Phase 3 in the
//     materials-warehouse-module memory). See services/matWhLedger.js's
//     normalizeColor() for the companion fix that keeps "MILL" sharing the
//     exact same physical stock pool as color: null rather than becoming a
//     third, disconnected color bucket.
//   - BLACK: a plain, correctly-named black entry -- an existing row
//     (mixCode "Bronze3Matt", colorDesc "Black") looks mislabeled, but
//     that row is left untouched (other Petra modules may already
//     reference it by that mixCode) -- this adds a new, separate row
//     instead of overwriting it.
//
// Idempotent: checks for an existing mixCode before inserting, safe to
// re-run. Confirmed live before writing: no existing MILL or BLACK
// mixCode/code row (exact match) in colorInfo.
import { sequelize2PetraErp } from "../config/db.js";

const AL_COLOR_TYPE_ID = 3; // confirmed live: colorType.colorTypeName='AL' -> colorTypeId=3

const rowExists = async (mixCode) => {
    const rows = await sequelize2PetraErp.query(
        "SELECT colorInfoId FROM colorInfo WHERE mixCode = :mixCode",
        { replacements: { mixCode }, type: sequelize2PetraErp.QueryTypes.SELECT },
    );
    return rows.length > 0;
};

const insertColor = async (mixCode, code, colorDesc) => {
    if (await rowExists(mixCode)) {
        console.log(`- colorInfo.mixCode='${mixCode}' already exists, skipping`);
        return;
    }
    await sequelize2PetraErp.query(
        "INSERT INTO colorInfo (mixCode, code, colorDesc, colorTypeId) VALUES (:mixCode, :code, :colorDesc, :colorTypeId)",
        { replacements: { mixCode, code, colorDesc, colorTypeId: AL_COLOR_TYPE_ID } },
    );
    console.log(`✅ Added colorInfo row: ${mixCode} — ${colorDesc}`);
};

const run = async () => {
    try {
        await insertColor("MILL", "MILL", "Mill Finish (Raw)");
        await insertColor("BLACK", "BLACK", "Black");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add colorInfo rows:", err);
        process.exit(1);
    }
};

run();
