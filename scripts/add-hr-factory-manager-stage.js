// ------------------------------------------------------
// backend/scripts/add-hr-factory-manager-stage.js
// ------------------------------------------------------
// Adds the factory-manager approval stage to all 4 HR request tables
// (MySQL, sequelizeUtf8): 'pending_factory_mgr' in the status ENUM (right
// after 'pending_manager', every other value kept as-is -- read live from
// INFORMATION_SCHEMA rather than retyped here) plus the 4 factoryMgr*
// decision columns. See needsFactoryManagerStep in utils/hrScope.js for
// who goes through this stage. Same idempotent check-then-ALTER pattern
// as add-hr-cancel-status.js. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const TABLES = ["HrLeaveRequests", "HrAttendanceCorrectionRequests", "HrTransportRequests", "HrOvertimeRequests"];
const COLUMNS = [
    ["factoryMgrApproverEmpNo", "INT NULL"],
    ["factoryMgrDecision", "ENUM('approved','rejected') NULL"],
    ["factoryMgrDecidedAt", "DATETIME NULL"],
    ["factoryMgrNote", "TEXT NULL"],
];

const run = async () => {
    try {
        for (const table of TABLES) {
            const [[col]] = await sequelizeUtf8.query(`
                SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'status'
            `, { replacements: [table] });
            if (!col) throw new Error(`${table}.status not found`);
            if (col.COLUMN_TYPE.includes("'pending_factory_mgr'")) {
                console.log(`⏭️  ${table}.status already includes 'pending_factory_mgr', skipping`);
            } else {
                const enumDef = col.COLUMN_TYPE.replace("'pending_manager'", "'pending_manager','pending_factory_mgr'");
                await sequelizeUtf8.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`status\` ${enumDef} NOT NULL DEFAULT 'pending_manager'`);
                console.log(`✅ ${table}.status -> ${enumDef}`);
            }

            for (const [name, def] of COLUMNS) {
                const [existing] = await sequelizeUtf8.query(`
                    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
                `, { replacements: [table, name] });
                if (existing.length > 0) {
                    console.log(`⏭️  ${table}.${name} already exists, skipping`);
                    continue;
                }
                await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${def}`);
                console.log(`✅ Added ${table}.${name}`);
            }
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add HR factory-manager stage:", err);
        process.exit(1);
    }
};

run();
