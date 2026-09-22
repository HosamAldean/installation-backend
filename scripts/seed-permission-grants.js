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
import { PERMISSIONS, ASSIGNABLE_ROLES } from "../constants/permissions.js";

// All HR-tier roles (added 2026-08-27): view-only oversight into the same
// 6 Follow-up pages gm can see -- enforced by READ_ONLY_ROLES/
// blockWritesForReadOnlyRoles in middleware/permissions.js, not by
// withholding INSTALLATION_MANAGE_ORDERS (deliberately NOT granted below,
// same as gm's exclusions -- HR wasn't asked to see order scheduling/
// management, just the oversight pages).
const HR_ROLES = ["hr", "hr_manager", "hr_factory", "hr_ittihad"];

// One entry per (key, roles-that-have-real-access-today) pair, derived
// directly from each backend route file's current authorizeRoles(...)/
// authorizeReadWrite(...) call (see the permission-system plan §2 for the
// file-by-file mapping this was read from).
const SEED_GRANTS = [
    // gm ("General Manager" -- added 2026-08-24): full Follow-up/
    // installation parity with installation_manager, by explicit request --
    // deliberately NOT given INSTALLATION_PRODUCTION_ORDERS/INSTALLATION_IRON
    // (production-specific, outside "Follow-up") or USERS_MANAGE (account
    // administration, never asked for -- see PERMISSION_GROUPS's
    // userManagement entry, which gm was deliberately left out of too).
    [PERMISSIONS.INSTALLATION_DASHBOARD_STATS, ["installation_manager", "gm", ...HR_ROLES]],
    [PERMISSIONS.INSTALLATION_REPORTS, ["installation_manager", "gm", ...HR_ROLES]],
    [PERMISSIONS.INSTALLATION_EMPLOYEES, ["installation_manager", "gm", ...HR_ROLES]],
    [PERMISSIONS.INSTALLATION_REQUESTS, ["installation_manager", "gm", ...HR_ROLES]],
    [PERMISSIONS.INSTALLATION_TEAMS, ["installation_manager", "gm", ...HR_ROLES]],
    [PERMISSIONS.INSTALLATION_STEPS, ["installation_manager", "gm", ...HR_ROLES]],
    // installation_supervisor is a view-only role (writes are blocked
    // regardless of this grant -- see blockWritesForReadOnlyRoles in
    // middleware/permissions.js, applied router-wide in instOrders.js) --
    // granted here because roleHomePath.ts sends it straight to /schedule
    // on login; without this grant that landing page 403s immediately. gm
    // gets full read/write here (not view-only) per explicit request.
    // HR-tier roles also need this despite being view-only -- the ENTIRE
    // instOrders.js router (including /assigned, which Reports.tsx's
    // useOrders() depends on for its own data) is gated behind this one key
    // at the router.use() level, not the granular installation.* keys
    // above. Without it, Reports/Dashboard/etc. render (their own route
    // guard only checks the granular key) but come back empty because the
    // underlying instOrders.js calls all 403 silently. blockWritesForRead
    // OnlyRoles (applied right after, same router) still fully blocks any
    // write for HR regardless of this grant.
    [PERMISSIONS.INSTALLATION_MANAGE_ORDERS, ["installation_manager", "installation_supervisor", "gm", ...HR_ROLES]],
    // view is the superset for the paired read/write files (iron.js,
    // projOrders.js) -- authorizeReadWrite's own contract requires
    // viewRoles to already include everyone who can edit, so seeding on
    // viewRoles covers both tiers under the one collapsed key.
    [PERMISSIONS.INSTALLATION_PRODUCTION_ORDERS, ["installation_manager", "production"]],
    [PERMISSIONS.INSTALLATION_IRON, ["installation_manager", "production"]],

    [PERMISSIONS.FIELD_TRACKING, ["installation_employee"]],
    // Per-screen sub-keys added alongside the umbrella FIELD_TRACKING key
    // (see constants/permissions.js) -- seeded to the same role that has
    // FIELD_TRACKING today so this rollout doesn't take anything away.
    [PERMISSIONS.FIELD_CHECKIN, ["installation_employee"]],
    [PERMISSIONS.FIELD_CHECK_DELIVERY, ["installation_employee"]],
    [PERMISSIONS.FIELD_SCAN_BARCODE, ["installation_employee"]],
    [PERMISSIONS.FIELD_SCAN_TASK, ["installation_employee"]],
    [PERMISSIONS.FIELD_MY_ORDER_COMPONENTS, ["installation_employee"]],

    // HR self-service (mobile) and mobile Settings are company-wide today
    // (no permission gate existed at all before this key) -- seeded to
    // every assignable role so this rollout doesn't restrict anyone.
    [PERMISSIONS.HR_REQUESTS, ASSIGNABLE_ROLES],
    [PERMISSIONS.MOBILE_SETTINGS, ASSIGNABLE_ROLES],

    [PERMISSIONS.SHIPPING_MAIN_STOCK, ["shipping_manager"]],
    [PERMISSIONS.SHIPPING_GLASS, ["shipping_manager"]],

    [PERMISSIONS.MATERIAL_STOCK_HOUSE, ["material_user"]],

    // Materials Warehouse WH.1 -- storekeeper's natural continuation of
    // Stock House access. Deliberately NOT seeded here:
    // MATERIALS_WAREHOUSE_INVOICES (accounting-only, not storekeeper --
    // the whole reason these are separate keys), PURCHASE_ORDERS,
    // ITEM_COST, and MASTER_DATA -- who should hold those is an open
    // question (see the Alpha Warehouse Analysis report §11), left for an
    // admin to grant explicitly via the matrix UI rather than guessed here.
    [PERMISSIONS.MATERIALS_WAREHOUSE_LANDING, ["material_user"]],
    [PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE, ["material_user"]],
    [PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE, ["material_user"]],
    [PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE, ["material_user"]],
    [PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS, ["material_user"]],

    // Profile Store sub-module -- same storekeeper continuation as WH.1
    // above, replacing the material_user's day-to-day Stock House access.
    // PROFILE_CATALOG (admin-only route guard, see requireAdmin in
    // materialsWarehouseProfileStore.js) is deliberately NOT seeded to
    // material_user, matching Stock House's own item-profile/assembly
    // catalog being admin-only there too.
    [PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_COATING, ["material_user"]],
    [PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_TRANSFER, ["material_user"]],

    // hr was later split into 3 scoped tiers -- hr_factory/hr_ittihad/hr
    // (see utils/hrScope.js) -- each granted the same queue/report keys
    // plain hr held before the split, since hrRequests.js/hrReports.js
    // gate all 3 tiers on these same keys and rely on hrScope.js's
    // data-driven WHERE clauses (not the grant table) to actually scope
    // what each tier sees.
    // gm added 2026-08-24 to all 6 hrAccounting-module keys at once (full
    // access, explicit request -- a GM overseeing both HR and Finance
    // queues company-wide, not scoped to one department the way the hr_*
    // tiers are), including ACCOUNTING_REQUESTS_QUEUE/HR_ITTIHAD_ATTENDANCE
    // even though hr_manager itself doesn't hold the former and only holds
    // the latter via a live (non-seeded) grant -- see this file's own
    // header comment on findOrCreate never resetting an admin's later
    // toggle, so adding gm here is additive, not a correction of those
    // other roles' existing access.
    [PERMISSIONS.HR_REQUESTS_QUEUE, ["hr_factory", "hr_ittihad", "hr", "hr_manager", "gm"]],
    [PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE, ["accounting", "accounting_manager", "gm"]],
    // HR_REPORTS was later split into these two (see constants/permissions.js) --
    // updated here so this script stays accurate if it's ever re-run, even
    // though the actual grant migration for the split itself happened
    // directly against the live table, not through this seed.
    [PERMISSIONS.HR_REPORTS_SUMMARY, ["hr_factory", "hr_ittihad", "hr", "hr_manager", "accounting", "accounting_manager", "gm"]],
    [PERMISSIONS.HR_REPORTS_TRANSPORT, ["hr_factory", "hr_ittihad", "hr", "hr_manager", "accounting", "accounting_manager", "gm"]],
    [PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE, ["hr_factory", "hr_ittihad", "hr", "hr_manager", "gm"]],
    // New alongside the Overtime request type itself -- same HR-tier-only
    // roles as HR_REPORTS_LEAVE_ATTENDANCE (not accounting -- overtime has
    // no Finance/payment stage), gm included for the same view-only
    // oversight reasoning as every other HR report tab.
    [PERMISSIONS.HR_REPORTS_OVERTIME, ["hr_factory", "hr_ittihad", "hr", "hr_manager", "gm"]],
    // Not previously in this seed list at all (granted live, directly
    // against the table, to hr_ittihad/hr_manager only) -- added here now
    // so this script stays a complete, accurate record, with gm alongside
    // those two per this same explicit request.
    [PERMISSIONS.HR_ITTIHAD_ATTENDANCE, ["hr_ittihad", "hr_manager", "gm"]],

    // lookups.js's old authorizeReadWrite view-tier, minus admin (bypass).
    // Edit stays hardcoded admin-only, not seeded/migrated here.
    [PERMISSIONS.LOOKUPS_VIEW, ["sales", "sales_manager", "accounting", "project_manager", "installation_employee"]],

    // USERS_MANAGE (routes/users.js) -- before this key existed, any
    // authenticated user could reach these endpoints with no permission
    // gate at all (see constants/permissions.js's comment on this key);
    // the only thing that ever actually limited what a request could DO
    // there was routes/users.js's own data-driven Supervisor_No/HR-tier
    // scoping. Seeded here to exactly the roles that hold real scope under
    // that logic today (see PERMISSION_GROUPS's userManagement entry) --
    // granting it to a role with no supervisory/HR scope would just be a
    // permission that unlocks an endpoint returning nothing.
    [PERMISSIONS.USERS_MANAGE, [
        "installation_manager",
        "shipping_manager",
        "sales_manager",
        "accounting_manager",
        "project_manager",
        "hr_factory",
        "hr_ittihad",
        "hr",
        "hr_manager",
    ]],
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
