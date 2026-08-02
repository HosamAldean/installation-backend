// ------------------------------------------------------
// backend/scripts/seed-permission-grants.js
// ------------------------------------------------------
// Creates the PermissionGrants table (if missing) and seeds it with grant
// rows reproducing TODAY'S REAL access for every module being converted
// off hardcoded authorizeRoles(...)/authorizeReadWrite(...) arrays.
//
// Unlike Phase 1's seed (empty table -- Petra ERP was already locked to
// admin-only, so nothing needed seeding), these areas are LIVE and working
// today for their current roles. Getting this right, and running it
// BEFORE any corresponding route file is swapped onto requirePermission(),
// is the single most important safety step in this rollout -- a missing
// seed row for a role that currently has real access means that role
// loses real, currently-working functionality the moment its route swaps.
//
// Idempotent and safely re-runnable: uses findOrCreate (insert-if-missing)
// for every row, NEVER deletes or overwrites -- re-running this after an
// admin has since toggled grants via the UI must never reset their
// changes back to these seed defaults.
//
// admin never gets a row here (bypass, see middleware/permissions.js).
// Petra ERP's 11 keys are deliberately NOT seeded here -- that module's
// empty-grants/admin-only state from Phase 1 is untouched by this script.
import { PermissionGrant } from "../models/PermissionGrant.js";
import { PERMISSIONS } from "../constants/permissions.js";

// One entry per (key, roles-that-have-real-access-today) pair, derived
// directly from each backend route file's current authorizeRoles(...)/
// authorizeReadWrite(...) call (see the permission-system plan §2 for the
// file-by-file mapping this was read from).
const SEED_GRANTS = [
    [PERMISSIONS.INSTALLATION_DASHBOARD_STATS, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_REPORTS, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_EMPLOYEES, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_REQUESTS, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_TEAMS, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_STEPS, ["installation_manager"]],
    [PERMISSIONS.INSTALLATION_MANAGE_ORDERS, ["installation_manager"]],
    // view is the superset for the paired read/write files (iron.js,
    // projOrders.js) -- authorizeReadWrite's own contract requires
    // viewRoles to already include everyone who can edit, so seeding on
    // viewRoles covers both tiers under the one collapsed key.
    [PERMISSIONS.INSTALLATION_PRODUCTION_ORDERS, ["installation_manager", "production"]],
    [PERMISSIONS.INSTALLATION_IRON, ["installation_manager", "production"]],

    [PERMISSIONS.FIELD_TRACKING, ["installation_employee"]],

    [PERMISSIONS.SHIPPING_MAIN_STOCK, ["shipping_manager"]],
    [PERMISSIONS.SHIPPING_GLASS, ["shipping_manager"]],

    [PERMISSIONS.MATERIAL_STOCK_HOUSE, ["material_user"]],

    [PERMISSIONS.HR_REQUESTS_QUEUE, ["hr", "hr_manager"]],
    [PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE, ["accounting", "accounting_manager"]],
    [PERMISSIONS.HR_REPORTS, ["hr", "hr_manager", "accounting", "accounting_manager"]],
    [PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE, ["hr", "hr_manager"]],

    // lookups.js's old authorizeReadWrite view-tier, minus admin (bypass).
    // Edit stays hardcoded admin-only, not seeded/migrated here.
    [PERMISSIONS.LOOKUPS_VIEW, ["sales", "sales_manager", "accounting", "project_manager", "installation_employee"]],
];

const run = async () => {
    try {
        await PermissionGrant.sync();
        console.log("✅ PermissionGrants table ready");

        let created = 0;
        let alreadyPresent = 0;
        for (const [permissionKey, roles] of SEED_GRANTS) {
            for (const role of roles) {
                const [, wasCreated] = await PermissionGrant.findOrCreate({
                    where: { role, permissionKey },
                    defaults: { grantedByUserId: null },
                });
                if (wasCreated) created++;
                else alreadyPresent++;
            }
        }
        console.log(`✅ Seed complete: ${created} rows inserted, ${alreadyPresent} already present (untouched)`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to seed PermissionGrants:", err);
        process.exit(1);
    }
};

run();
