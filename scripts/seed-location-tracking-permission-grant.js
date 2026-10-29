// ------------------------------------------------------
// backend/scripts/seed-location-tracking-permission-grant.js
// ------------------------------------------------------
// Grants field.location_tracking to installation_employee -- the phone's
// background location tracking is for installation users only by default
// (2026-10-29); an admin can tick any other role on the Permissions page.
//
// Idempotent (findOrCreate), safe to re-run.
import { PermissionGrant } from "../models/PermissionGrant.js";
import { PERMISSIONS } from "../constants/permissions.js";

const GRANTS = [
    ["installation_employee", PERMISSIONS.FIELD_LOCATION_TRACKING],
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
        console.error("❌ Failed to seed location tracking permission grant:", err);
        process.exit(1);
    }
};

run();
