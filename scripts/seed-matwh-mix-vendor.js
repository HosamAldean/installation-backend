// ------------------------------------------------------
// backend/scripts/seed-matwh-mix-vendor.js
// ------------------------------------------------------
// Adds "MIX" as a real vendor -- per direct request, 2026-09-23: "the
// coating request need to add vendor or provider[,] the standard MIX and we
// can add other compan[ies]". MatWhExternalProcessing.js's own model
// comment already says this table is "modeled after Stock House's MIX
// table" -- MIX is the real, standard/default coating processor name from
// that old system, just never existed as a row in this codebase's own
// Vendor table. Doesn't change vendor selection anywhere -- it just becomes
// pickable from the same vendor dropdown every coating job's Confirm & Send
// / Send Out flow already uses, alongside Schuco/Alupco/etc.
//
// Idempotent (checks vendorName first), safe to re-run.
import { Vendor } from "../models/Vendor.js";

const run = async () => {
    const existing = await Vendor.findOne({ where: { vendorName: "MIX" } });
    if (existing) {
        console.log(`- Vendor "MIX" already exists (vendorId ${existing.vendorId}), skipping`);
    } else {
        const row = await Vendor.create({ vendorName: "MIX", vendorDesc: "Standard coating/Mix processor" });
        console.log(`✅ Added vendor "MIX" (vendorId ${row.vendorId})`);
    }
    process.exit(0);
};
run().catch((err) => { console.error("❌ Failed to seed MIX vendor:", err); process.exit(1); });
