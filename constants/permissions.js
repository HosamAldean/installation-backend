// backend/constants/permissions.js
// Single source of truth for the app's page/feature-level permission keys.
// Grain is one key per backend enforcement point, not per individual CRUD
// action within it -- see the permission-system plan for why. Started as
// Petra-ERP-only (11 keys); generalized to cover every module before merge.
export const PERMISSIONS = Object.freeze({
    // Petra ERP (Phase 1 -- unchanged)
    PETRA_ERP_LANDING: 'petra_erp.landing',
    PETRA_ERP_PROJECTS: 'petra_erp.projects',
    PETRA_ERP_CLIENTS: 'petra_erp.clients',
    PETRA_ERP_ORDERS: 'petra_erp.orders',
    PETRA_ERP_CASH_FLOW: 'petra_erp.cash_flow',
    PETRA_ERP_OFFERS: 'petra_erp.offers',
    PETRA_ERP_CONTROL_SHEET: 'petra_erp.control_sheet',
    PETRA_ERP_REPORTING: 'petra_erp.reporting',
    PETRA_ERP_LEADS: 'petra_erp.leads',
    PETRA_ERP_TIMESHEETS: 'petra_erp.timesheets',
    PETRA_ERP_CR09: 'petra_erp.cr09',

    // Installation (installation_manager, admin; production on the two
    // paired production/manufacturing keys)
    INSTALLATION_DASHBOARD_STATS: 'installation.dashboard_stats',
    INSTALLATION_REPORTS: 'installation.reports',
    INSTALLATION_EMPLOYEES: 'installation.employees',
    INSTALLATION_REQUESTS: 'installation.requests',
    INSTALLATION_TEAMS: 'installation.teams',
    INSTALLATION_STEPS: 'installation.steps',
    INSTALLATION_MANAGE_ORDERS: 'installation.manage_orders',
    INSTALLATION_PRODUCTION_ORDERS: 'installation.production_orders',
    INSTALLATION_IRON: 'installation.iron',

    // Field (user, admin) -- FIELD_TRACKING is the original umbrella key,
    // still checked by the handful of routes genuinely shared across
    // multiple field-ops screens (see followUp.js's own comments on which
    // ones). The keys below let the admin grant matrix and mobile Home
    // screen toggle each field-ops screen independently on top of that.
    FIELD_TRACKING: 'field.tracking',
    FIELD_CHECKIN: 'field.checkin',
    FIELD_CHECK_DELIVERY: 'field.check_delivery',
    FIELD_SCAN_BARCODE: 'field.scan_barcode',
    FIELD_SCAN_TASK: 'field.scan_task',
    FIELD_MY_ORDER_COMPONENTS: 'field.my_order_components',

    // Shipping (shipping_manager, admin)
    SHIPPING_MAIN_STOCK: 'shipping.main_stock',
    SHIPPING_GLASS: 'shipping.glass',

    // Material (material_user, admin)
    MATERIAL_STOCK_HOUSE: 'material.stock_house',

    // Materials Warehouse (WH.1+) -- replaces Stock House and Alpha's
    // warehouse/purchasing functions, per the Alpha Warehouse Analysis
    // report. One key per responsibility, not one per page, on purpose --
    // materials_warehouse.invoices is deliberately separate from .receive
    // so a storekeeper role can be granted the latter without the former
    // (raised directly: "any storekeeper can add invoice, we need more
    // than one rule").
    // Separate from every operational key below, same as
    // PETRA_ERP_LANDING -- lets a role reach the module's landing page
    // without also implying access to any specific sub-area.
    MATERIALS_WAREHOUSE_LANDING: 'materials_warehouse.landing',
    MATERIALS_WAREHOUSE_RECEIVE: 'materials_warehouse.receive',
    MATERIALS_WAREHOUSE_RESERVE: 'materials_warehouse.reserve',
    MATERIALS_WAREHOUSE_ISSUE: 'materials_warehouse.issue',
    MATERIALS_WAREHOUSE_PURCHASE_ORDERS: 'materials_warehouse.purchase_orders',
    MATERIALS_WAREHOUSE_INVOICES: 'materials_warehouse.invoices',
    MATERIALS_WAREHOUSE_ITEM_COST: 'materials_warehouse.item_cost',
    MATERIALS_WAREHOUSE_MASTER_DATA: 'materials_warehouse.master_data',
    MATERIALS_WAREHOUSE_REPORTS: 'materials_warehouse.reports',

    // Material Write-off (WM 10-41 request / WM 10-42 report) -- split the
    // same way RESERVE/ISSUE already is: a storekeeper builds/submits the
    // request and later files the destruction report + committee sign-off,
    // but the actual approve/reject decision (and the report's upper-
    // management acknowledgment) is a distinct, higher-trust action that
    // shouldn't come bundled with ordinary storekeeper access.
    MATERIALS_WAREHOUSE_WRITEOFF: 'materials_warehouse.writeoff',
    MATERIALS_WAREHOUSE_WRITEOFF_APPROVE: 'materials_warehouse.writeoff_approve',

    // Store Manager dashboard (reservation status/dates overview) and the
    // internal storekeeper->manager->purchasing review chain an auto-
    // generated shortfall PO now goes through before purchasing acts on it
    // (services/matWhReservations.js raises it, .reserve holders confirm
    // its data is complete, .store_manager holders confirm it next, then
    // .purchasing holders take it from there) -- a manually-created PO
    // skips this chain entirely and is unaffected, per direct decision.
    MATERIALS_WAREHOUSE_STORE_MANAGER: 'materials_warehouse.store_manager',
    MATERIALS_WAREHOUSE_PURCHASING: 'materials_warehouse.purchasing',

    // Profile Store sub-module -- the aluminum-profile (profile/color/
    // length/barcode) workflow that replaces Stock House, distinct from the
    // generic item/PO-based workflow above. Receive/reserve/issue/reports
    // reuse the generic keys above (receiving or reserving material is the
    // same responsibility regardless of item type); these three cover
    // actions with no equivalent on the generic side.
    MATERIALS_WAREHOUSE_PROFILE_COATING: 'materials_warehouse.profile_coating',
    MATERIALS_WAREHOUSE_PROFILE_TRANSFER: 'materials_warehouse.profile_transfer',
    MATERIALS_WAREHOUSE_PROFILE_CATALOG: 'materials_warehouse.profile_catalog',

    // HR self-service on mobile (Leave/Attendance/Transport request forms,
    // My HR Requests) -- distinct from HR_REQUESTS_QUEUE below, which gates
    // HR *staff* reviewing everyone else's requests, not a worker's own.
    HR_REQUESTS: 'hr.requests',
    // Mobile Settings screen (password/photo) entry point.
    MOBILE_SETTINGS: 'mobile.settings',

    // HR / Accounting
    HR_REQUESTS_QUEUE: 'hr.requests_queue',
    ACCOUNTING_REQUESTS_QUEUE: 'accounting.requests_queue',
    // Split from one combined hr.reports key so HR and Accounting can be
    // granted the Summary and Transport report tabs independently --
    // previously a single key gated both GET /summary and GET /transport
    // together.
    HR_REPORTS_SUMMARY: 'hr.reports_summary',
    HR_REPORTS_TRANSPORT: 'hr.reports_transport',
    HR_REPORTS_LEAVE_ATTENDANCE: 'hr.reports_leave_attendance',
    HR_REPORTS_OVERTIME: 'hr.reports_overtime',
    HR_ITTIHAD_ATTENDANCE: 'hr.ittihad_attendance',
    // Toggling the employee Payslip report's global on/off switch (see
    // models/PayslipVisibility.js) -- separate from HR_REQUESTS_QUEUE/
    // HR_REPORTS_* since this controls a company-wide feature switch, not
    // a view into other employees' requests/reports.
    HR_PAYSLIP_VISIBILITY_MANAGE: 'hr.payslip_visibility_manage',

    // Lookups (routes/lookups.js) -- VIEW only. Editing reference data
    // stays hardcoded admin-only (authorizeRoles('admin')), not migrated
    // here on purpose -- see that route file's own comment.
    LOOKUPS_VIEW: 'lookups.view',

    // User account management (admin/Users.tsx, "Create User" included) --
    // previously reachable by ANY authenticated user with zero permission
    // gate at all (backend/routes/users.js's own data-driven
    // Supervisor_No/HR-tier scoping was the only thing limiting what you
    // could actually DO there -- nothing stopped an unrelated employee
    // from just opening the page). This key adds an actual admin-editable
    // on/off control on top of that existing scoping, same pattern as
    // every other module.
    USERS_MANAGE: 'users.manage',
});

// Every role that can be granted a permission. `admin` is deliberately
// excluded -- it bypasses this system entirely (see
// middleware/permissions.js), so it's never a togglable row in the admin
// UI and never needs a grant row in the DB. `production` has no frontend
// login path today but is included per explicit confirmation -- it's a
// real role the backend already grants access to (iron.js/projOrders.js).
// Defined before PERMISSION_GROUPS since the mobileSelfService group below
// references it directly.
export const ASSIGNABLE_ROLES = [
    'installation_manager',
    'installation_supervisor',
    'gm',
    'production',
    'installation_employee',
    'employee',
    'shipping_manager',
    'material_user',
    'sales',
    'sales_manager',
    'accounting',
    'accounting_manager',
    'project_manager',
    'hr_factory',
    'hr_ittihad',
    'hr',
    'hr_manager',
];

// Grouped by module for the admin grant-matrix UI (frontend/src/pages/
// admin/Permissions.tsx) -- `roles` lists only the roles actually relevant
// to that module's keys, so the UI doesn't render a column of permanently-
// irrelevant cells (e.g. Shipping's grid never shows an `hr` column).
export const PERMISSION_GROUPS = [
    {
        module: 'petraErp',
        label: 'Petra ERP',
        roles: ['sales', 'sales_manager', 'accounting', 'project_manager'],
        items: [
            { key: PERMISSIONS.PETRA_ERP_LANDING, labelKey: 'petraErp' },
            { key: PERMISSIONS.PETRA_ERP_PROJECTS, labelKey: 'projects' },
            { key: PERMISSIONS.PETRA_ERP_CLIENTS, labelKey: 'clients' },
            { key: PERMISSIONS.PETRA_ERP_ORDERS, labelKey: 'salesOrders' },
            { key: PERMISSIONS.PETRA_ERP_CASH_FLOW, labelKey: 'cashFlow' },
            { key: PERMISSIONS.PETRA_ERP_OFFERS, labelKey: 'offers' },
            { key: PERMISSIONS.PETRA_ERP_CONTROL_SHEET, labelKey: 'controlSheet' },
            { key: PERMISSIONS.PETRA_ERP_REPORTING, labelKey: 'reporting' },
            { key: PERMISSIONS.PETRA_ERP_LEADS, labelKey: 'leads' },
            { key: PERMISSIONS.PETRA_ERP_TIMESHEETS, labelKey: 'timesheets' },
            { key: PERMISSIONS.PETRA_ERP_CR09, labelKey: 'cr09' },
        ],
    },
    {
        module: 'installation',
        label: 'Installation',
        roles: ['installation_manager', 'installation_supervisor', 'gm', 'production', 'hr', 'hr_manager', 'hr_factory', 'hr_ittihad'],
        items: [
            { key: PERMISSIONS.INSTALLATION_DASHBOARD_STATS, labelKey: 'dashboard' },
            { key: PERMISSIONS.INSTALLATION_REPORTS, labelKey: 'reports' },
            { key: PERMISSIONS.INSTALLATION_EMPLOYEES, labelKey: 'employees' },
            { key: PERMISSIONS.INSTALLATION_REQUESTS, labelKey: 'installationRequests' },
            { key: PERMISSIONS.INSTALLATION_TEAMS, labelKey: 'teams' },
            { key: PERMISSIONS.INSTALLATION_STEPS, labelKey: 'installationSteps' },
            { key: PERMISSIONS.INSTALLATION_MANAGE_ORDERS, labelKey: 'manageOrders' },
            { key: PERMISSIONS.INSTALLATION_PRODUCTION_ORDERS, labelKey: 'productionOrders' },
            { key: PERMISSIONS.INSTALLATION_IRON, labelKey: 'iron' },
        ],
    },
    {
        module: 'field',
        label: 'Field',
        // 'employee' included alongside 'installation_employee' -- the
        // plain employee role has no field.tracking by default (HR
        // self-service only, see RoleBasedHome.tsx on the frontend), but an
        // admin can still opt a specific employee-role account into it here
        // without needing a role change.
        roles: ['installation_employee', 'employee'],
        items: [
            { key: PERMISSIONS.FIELD_TRACKING, labelKey: 'fieldTracking' },
            { key: PERMISSIONS.FIELD_CHECKIN, labelKey: 'fieldCheckin' },
            { key: PERMISSIONS.FIELD_CHECK_DELIVERY, labelKey: 'fieldCheckDelivery' },
            { key: PERMISSIONS.FIELD_SCAN_BARCODE, labelKey: 'fieldScanBarcode' },
            { key: PERMISSIONS.FIELD_SCAN_TASK, labelKey: 'fieldScanTask' },
            { key: PERMISSIONS.FIELD_MY_ORDER_COMPONENTS, labelKey: 'fieldMyOrderComponents' },
        ],
    },
    {
        module: 'mobileSelfService',
        label: 'Mobile Self-Service',
        // Company-wide today (see CLAUDE.md's mobile section) -- every
        // assignable role gets a column so an admin can restrict a specific
        // role's mobile HR Requests / Settings access without a code
        // change, but nothing is actually restricted by default (seeded to
        // every role, see seed-permission-grants.js).
        roles: ASSIGNABLE_ROLES,
        items: [
            { key: PERMISSIONS.HR_REQUESTS, labelKey: 'mobileHrRequests' },
            { key: PERMISSIONS.MOBILE_SETTINGS, labelKey: 'mobileSettings' },
        ],
    },
    {
        module: 'shipping',
        label: 'Shipping',
        roles: ['shipping_manager'],
        items: [
            { key: PERMISSIONS.SHIPPING_MAIN_STOCK, labelKey: 'mainStock' },
            { key: PERMISSIONS.SHIPPING_GLASS, labelKey: 'glass' },
        ],
    },
    {
        module: 'material',
        label: 'Material',
        roles: ['material_user'],
        items: [{ key: PERMISSIONS.MATERIAL_STOCK_HOUSE, labelKey: 'stockHouse' }],
    },
    {
        // WH.1: only master data (stores/items/QC categories/vendor
        // fields) is live -- receive/reserve/issue/purchase_orders/
        // invoices/item_cost are registered here so they're assignable
        // from WH.1 on, but have no enforcement point yet until their
        // owning phase (WH.2/WH.3) ships the actual routes.
        module: 'materialsWarehouse',
        label: 'Materials Warehouse',
        roles: ['material_user', 'accounting', 'accounting_manager'],
        items: [
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_LANDING, labelKey: 'materialsWarehouseLanding' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_RECEIVE, labelKey: 'materialsWarehouseReceive' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_RESERVE, labelKey: 'materialsWarehouseReserve' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_ISSUE, labelKey: 'materialsWarehouseIssue' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASE_ORDERS, labelKey: 'materialsWarehousePurchaseOrders' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_INVOICES, labelKey: 'materialsWarehouseInvoices' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_ITEM_COST, labelKey: 'materialsWarehouseItemCost' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_MASTER_DATA, labelKey: 'materialsWarehouseMasterData' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_REPORTS, labelKey: 'materialsWarehouseReports' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF, labelKey: 'materialsWarehouseWriteoff' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_WRITEOFF_APPROVE, labelKey: 'materialsWarehouseWriteoffApprove' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_STORE_MANAGER, labelKey: 'materialsWarehouseStoreManager' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_PURCHASING, labelKey: 'materialsWarehousePurchasing' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_COATING, labelKey: 'materialsWarehouseProfileCoating' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_TRANSFER, labelKey: 'materialsWarehouseProfileTransfer' },
            { key: PERMISSIONS.MATERIALS_WAREHOUSE_PROFILE_CATALOG, labelKey: 'materialsWarehouseProfileCatalog' },
        ],
    },
    {
        module: 'hrAccounting',
        label: 'HR / Accounting',
        roles: ['hr_factory', 'hr_ittihad', 'hr', 'hr_manager', 'accounting', 'accounting_manager', 'gm'],
        items: [
            { key: PERMISSIONS.HR_REQUESTS_QUEUE, labelKey: 'hrQueue' },
            { key: PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE, labelKey: 'financeQueue' },
            { key: PERMISSIONS.HR_REPORTS_SUMMARY, labelKey: 'hrReportsSummary' },
            { key: PERMISSIONS.HR_REPORTS_TRANSPORT, labelKey: 'hrReportsTransport' },
            { key: PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE, labelKey: 'hrReportsLeaveAttendance' },
            { key: PERMISSIONS.HR_REPORTS_OVERTIME, labelKey: 'hrReportsOvertime' },
            { key: PERMISSIONS.HR_ITTIHAD_ATTENDANCE, labelKey: 'hrIttihadAttendance' },
            { key: PERMISSIONS.HR_PAYSLIP_VISIBILITY_MANAGE, labelKey: 'hrPayslipVisibilityManage' },
        ],
    },
    {
        module: 'lookups',
        label: 'Lookups',
        roles: ['sales', 'sales_manager', 'accounting', 'project_manager', 'installation_employee'],
        items: [{ key: PERMISSIONS.LOOKUPS_VIEW, labelKey: 'lookups' }],
    },
    {
        module: 'userManagement',
        label: 'User Management',
        // Every role that currently has real data-driven scope over some
        // slice of employees in routes/users.js (direct reports via
        // Supervisor_No, or one of the HR-tier department/company scopes)
        // -- granting/revoking this key controls whether they can reach
        // the Create/Manage Users page at all, independent of that scope.
        roles: [
            'installation_manager',
            'shipping_manager',
            'sales_manager',
            'accounting_manager',
            'project_manager',
            'hr_factory',
            'hr_ittihad',
            'hr',
            'hr_manager',
        ],
        items: [{ key: PERMISSIONS.USERS_MANAGE, labelKey: 'usersManage' }],
    },
];

// Flat ordered list (all groups concatenated) for consumers that don't
// need the grouping -- the admin API response, the seed script, etc.
export const PERMISSION_LIST = PERMISSION_GROUPS.flatMap((g) => g.items);
