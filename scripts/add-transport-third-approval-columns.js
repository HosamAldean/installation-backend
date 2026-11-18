// One-off: third approval stage for Ittihad transport reimbursements
// (2026-11-15) -- manager (Work_place 1364) -> 554 -> 100254. 554's
// decision stays in factoryMgr*; 100254's lands in these columns.
// Idempotent. Undo: ALTER TABLE HrTransportRequests DROP COLUMN for each.
// Backup taken first: C:\IA\backups\HrTransportRequests-before-third-approval-2026-11-15.json
import "dotenv/config";
import { sequelize } from "../config/db.js";

const COLUMNS = [
    ["thirdApproverEmpNo", "INT NULL"],
    ["thirdDecision", "ENUM('approved','rejected') NULL"],
    ["thirdDecidedAt", "DATETIME NULL"],
    ["thirdNote", "TEXT NULL"],
];

const existing = new Set(
    (await sequelize.query("SHOW COLUMNS FROM HrTransportRequests", { type: "SELECT" })).map((c) => c.Field),
);
for (const [name, def] of COLUMNS) {
    if (existing.has(name)) {
        console.log("exists ", name);
        continue;
    }
    await sequelize.query(`ALTER TABLE HrTransportRequests ADD COLUMN \`${name}\` ${def} AFTER factoryMgrNote`);
    console.log("added  ", name);
}
const after = (await sequelize.query("SHOW COLUMNS FROM HrTransportRequests", { type: "SELECT" }))
    .filter((c) => c.Field.startsWith("third"))
    .map((c) => `${c.Field} ${c.Type} null=${c.Null}`);
console.log(after.join("\n"));
console.log("rows:", (await sequelize.query("SELECT COUNT(*) n FROM HrTransportRequests", { type: "SELECT" }))[0].n);
process.exit(0);
