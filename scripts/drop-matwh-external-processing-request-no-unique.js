// ------------------------------------------------------
// backend/scripts/drop-matwh-external-processing-request-no-unique.js
// ------------------------------------------------------
// Drops the UNIQUE index on matWhExternalProcessing.requestNo, added by
// add-matwh-external-processing-request-no.js. That index was correct for
// the original one-request-per-job design, but a same-day follow-up
// (2026-09-23, direct request: "the auto request no[.] for the all
// reservation order for the same store, not for every item") now makes
// MULTIPLE coating jobs deliberately SHARE one requestNo when they're
// raised for the same (reservation, store) pairing (see
// matWhReservations.js's createCoatingJob) -- the unique constraint made
// that impossible (caught live: a real SequelizeUniqueConstraintError on
// the second job in a group). requestNo is now a shared group label, not a
// per-row identifier.
//
// Idempotent (checks INFORMATION_SCHEMA.STATISTICS first), safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const indexExists = async (table, indexName) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :indexName
    `, { replacements: { table, indexName } });
    return rows.length > 0;
};

const run = async () => {
    try {
        const indexName = "matWhExternalProcessing_requestNo";
        if (await indexExists("matWhExternalProcessing", indexName)) {
            await sequelizeUtf8.query(`ALTER TABLE \`matWhExternalProcessing\` DROP INDEX \`${indexName}\``);
            console.log(`✅ Dropped unique index ${indexName}`);
        } else {
            console.log(`- Index ${indexName} does not exist, skipping`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to drop matWhExternalProcessing requestNo unique index:", err);
        process.exit(1);
    }
};

run();
