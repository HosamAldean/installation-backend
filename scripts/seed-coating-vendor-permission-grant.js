// ------------------------------------------------------
// backend/scripts/seed-coating-vendor-permission-grant.js
// ------------------------------------------------------
// Grants the two Mix roles their permission keys. Deliberately NOT added
// to ASSIGNABLE_ROLES/seed-permission-grants.js's SEED_GRANTS -- that
// list's two wildcard entries (HR_REQUESTS, MOBILE_SETTINGS seeded to
// every assignable role) would otherwise hand an external vendor account
// the HR self-service mobile menu, which it has no business holding.
//
// mix_employee gets the base portal key only (request ack/scheduling,
// materials-received, ready-for-return). mix_manager gets both -- the
// base key plus invoice creation/management, per direct request that
// invoicing is a manager-only action.
//
// Idempotent (findOrCreate), safe to re-run.
import { PermissionGrant } from "../models/PermissionGrant.js";
import { PERMISSIONS } from "../constants/permissions.js";

const GRANTS = [
    ["mix_employee", PERMISSIONS.MATERIALS_WAREHOUSE_COATING_VENDOR],
    ["mix_manager", PERMISSIONS.MATERIALS_WAREHOUSE_COATING_VENDOR],
    ["mix_manager", PERMISSIONS.MATERIALS_WAREHOUSE_COATING_VENDOR_INVOICE],
];

const run = async () => {
    try {
        for (const [role, permissionKey] of GRANTS) {
            const [, created] = await PermissionGrant.findOrCreate({
                where: { role, permissionKey },
                defaults: { grantedByUserId: null },
            });
            console.log(created ? `✅ Granted ${role} -> ${permissionKey}` : `- ${role} -> ${permissionKey} already present, skipping`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to seed Mix permission grants:", err);
        process.exit(1);
    }
};

run();
