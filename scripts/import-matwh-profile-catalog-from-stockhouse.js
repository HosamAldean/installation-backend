// ------------------------------------------------------
// backend/scripts/import-matwh-profile-catalog-from-stockhouse.js
// ------------------------------------------------------
// One-time copy of the aluminum profile catalog from the OLD system
// (SQL Server `stockhouse` pool: guest.ItemProfile) into the NEW Materials
// Warehouse's own matWhProfileCatalog table (MySQL) -- the direct aluminum
// counterpart to import-matwh-items-from-petrastock.js.
//
// READ-ONLY against the old system: this script issues exactly one SELECT
// against SQL Server (via getSqlPool('stockhouse')) and never calls
// .query() with anything but SELECT there -- no INSERT/UPDATE/DELETE
// touches guest.ItemProfile or any other Stock House table. Every write
// this script performs lands only in the new MySQL matWhProfileCatalog
// table. Safe to re-run: matched by profileNo via findOrCreate, so a
// repeat run (or one that runs after someone's added real rows by hand,
// like the pre-existing "512 / zeus" row already in this table) touches
// nothing that already exists.
//
// Field mapping (verified live 2026-09-15 against real guest.ItemProfile
// rows, 1,973 total):
//   profileNo   <- ProfileNO (confirmed unique, 0 duplicates)
//   profileName <- ProfileName (100% populated)
//   details     <- Details (0/1973 rows actually have one -- carried over
//                  anyway in case that changes before this is re-run)
//   photoUrl    NOT copied -- Details/PhotoUrl are both unused in the old
//   data (0 rows have a PhotoUrl), and even if they weren't, the old
//   system's PhotoUrl points at ITS OWN file storage, not this app's
//   uploads/profile-catalog-photos/ directory, so blindly copying the
//   string would produce a broken link rather than a working photo.
//   profileNameAr / barcode -- left NULL; no old-system source for either
//   (ItemProfile has no Arabic name column, and profile-level barcodes are
//   a new-module addition -- the old system only barcodes physical stock
//   units, not catalog entries, via ComputerNO on the transaction tables).
import { getSqlPool } from "../config/db.js";
import { MatWhProfileCatalog } from "../models/MatWhProfileCatalog.js";

const run = async () => {
    const sh = await getSqlPool("stockhouse");

    // The ONLY query this script sends to SQL Server -- read-only.
    const result = await sh.request().query(`
        SELECT ProfileNO, ProfileName, Details
        FROM guest.ItemProfile
    `);
    const rows = result.recordset;
    console.log(`Read ${rows.length} rows from guest.ItemProfile, old system untouched (SELECT only).`);

    let created = 0;
    let alreadyPresent = 0;
    let skipped = 0;

    for (const row of rows) {
        const profileNo = String(row.ProfileNO || "").trim();
        const profileName = String(row.ProfileName || "").trim();
        if (!profileNo || !profileName) { skipped++; continue; }

        try {
            const [, wasCreated] = await MatWhProfileCatalog.findOrCreate({
                where: { profileNo },
                defaults: {
                    profileNo, profileName,
                    details: String(row.Details || "").trim() || null,
                },
            });
            if (wasCreated) created++; else alreadyPresent++;
        } catch (err) {
            console.error(`⚠️ Skipped ${profileNo}:`, err.message);
            skipped++;
        }
    }

    console.log(`✅ Import complete — created: ${created}, already present: ${alreadyPresent}, skipped: ${skipped}`);
    process.exit(0);
};

run().catch((err) => {
    console.error("❌ Import failed:", err);
    process.exit(1);
});
