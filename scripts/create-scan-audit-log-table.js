// ------------------------------------------------------
// backend/scripts/create-scan-audit-log-table.js
// ------------------------------------------------------
// Creates the ScanAuditLogs table backing the server-persisted warehouse
// scan history (see backend/models/ScanAuditLog.js). Lives on the
// sequelizeUtf8 MySQL connection, same as FollowUpNotes/the HR tables --
// a genuinely new table with no legacy Access/ERP equivalent.
//
// Uses the model's own .sync() (create-if-missing, non-destructive), same
// as create-hr-tables.js. Safe to re-run.
import { ScanAuditLog } from "../models/ScanAuditLog.js";

const run = async () => {
    try {
        await ScanAuditLog.sync();
        console.log("✅ ScanAuditLogs ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create ScanAuditLogs table:", err);
        process.exit(1);
    }
};

run();
