// ------------------------------------------------------
// backend/scripts/seed-coating-vendor-permission-grant.js
// ------------------------------------------------------
// Grants the new 'coating_vendor' role its one permission key
// (materials_warehouse.coating_vendor). Deliberately NOT added to
// ASSIGNABLE_ROLES/seed-permission-grants.js's SEED_GRANTS -- that list's
// two wildcard entries (HR_REQUESTS, MOBILE_SETTINGS seeded to every
// assignable role) would otherwise hand an external vendor account the
// HR self-service mobile menu, which it has no business holding. This
// role gets exactly one grant, seeded here on its own.
//
// Idempotent (findOrCreate), safe to re-run.
import { PermissionGrant } from "../models/PermissionGrant.js";
import { PERMISSIONS } from "../constants/permissions.js";

const run = async () => {
    try {
        const [, created] = await PermissionGrant.findOrCreate({
            where: { role: "coating_vendor", permissionKey: PERMISSIONS.MATERIALS_WAREHOUSE_COATING_VENDOR },
            defaults: { grantedByUserId: null },
        });
        console.log(created ? "✅ Granted coating_vendor -> materials_warehouse.coating_vendor" : "- Grant already present, skipping");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to seed coating_vendor permission grant:", err);
        process.exit(1);
    }
};

run();
