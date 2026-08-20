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

    // Field (user, admin) -- one key covers 4 pages deliberately, the
    // backend makes no finer distinction between them today.
    FIELD_TRACKING: 'field.tracking',

    // Shipping (shipping_manager, admin)
    SHIPPING_MAIN_STOCK: 'shipping.main_stock',
    SHIPPING_GLASS: 'shipping.glass',

    // Material (material_user, admin)
    MATERIAL_STOCK_HOUSE: 'material.stock_house',

    // HR / Accounting
    HR_REQUESTS_QUEUE: 'hr.requests_queue',
    ACCOUNTING_REQUESTS_QUEUE: 'accounting.requests_queue',
    HR_REPORTS: 'hr.reports',
    HR_REPORTS_LEAVE_ATTENDANCE: 'hr.reports_leave_attendance',

    // Lookups (routes/lookups.js) -- VIEW only. Editing reference data
    // stays hardcoded admin-only (authorizeRoles('admin')), not migrated
    // here on purpose -- see that route file's own comment.
    LOOKUPS_VIEW: 'lookups.view',
});

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
        roles: ['installation_manager', 'production'],
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
        items: [{ key: PERMISSIONS.FIELD_TRACKING, labelKey: 'fieldTracking' }],
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
        module: 'hrAccounting',
        label: 'HR / Accounting',
        roles: ['hr', 'hr_manager', 'accounting', 'accounting_manager'],
        items: [
            { key: PERMISSIONS.HR_REQUESTS_QUEUE, labelKey: 'hrQueue' },
            { key: PERMISSIONS.ACCOUNTING_REQUESTS_QUEUE, labelKey: 'financeQueue' },
            { key: PERMISSIONS.HR_REPORTS, labelKey: 'hrReports' },
            { key: PERMISSIONS.HR_REPORTS_LEAVE_ATTENDANCE, labelKey: 'hrReportsLeaveAttendance' },
        ],
    },
    {
        module: 'lookups',
        label: 'Lookups',
        roles: ['sales', 'sales_manager', 'accounting', 'project_manager', 'installation_employee'],
        items: [{ key: PERMISSIONS.LOOKUPS_VIEW, labelKey: 'lookups' }],
    },
];

// Flat ordered list (all groups concatenated) for consumers that don't
// need the grouping -- the admin API response, the seed script, etc.
export const PERMISSION_LIST = PERMISSION_GROUPS.flatMap((g) => g.items);

// Every role that can be granted a permission. `admin` is deliberately
// excluded -- it bypasses this system entirely (see
// middleware/permissions.js), so it's never a togglable row in the admin
// UI and never needs a grant row in the DB. `production` has no frontend
// login path today but is included per explicit confirmation -- it's a
// real role the backend already grants access to (iron.js/projOrders.js).
export const ASSIGNABLE_ROLES = [
    'installation_manager',
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
    'hr',
    'hr_manager',
];
