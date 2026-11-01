// ------------------------------------------------------
// backend/scripts/create-it-licenses-tables.js
// ------------------------------------------------------
// Creates ItLicenses + ItLicenseRenewals + ItLicenseAttachments (models/
// ItLicense*.js) for the admin IT licenses tracker. New,
// empty tables only -- uses the models' own .sync() (create-if-missing,
// non-destructive), same as create-security-alerts-table.js. Safe to re-run.
import { ItLicense } from "../models/ItLicense.js";
import { ItLicenseRenewal } from "../models/ItLicenseRenewal.js";
import { ItLicenseAttachment } from "../models/ItLicenseAttachment.js";

const run = async () => {
    try {
        await ItLicense.sync();
        await ItLicenseRenewal.sync();
        await ItLicenseAttachment.sync();
        console.log("✅ ItLicenses + ItLicenseRenewals + ItLicenseAttachments ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create IT license tables:", err);
        process.exit(1);
    }
};

run();
