// ------------------------------------------------------
// backend/scripts/add-transport-payment-columns.js
// ------------------------------------------------------
// Adds 4 columns to the existing HrTransportRequests table (MySQL,
// sequelizeUtf8): additionalAmount/additionalAmountNote (a manual top-up
// Finance can add on top of the km/fare calculation) and paidAt/
// paidByUserId (Accounting's separate "actually disbursed" confirmation,
// distinct from Finance's "approved" decision). See models/
// HrTransportRequest.js for the field rationale.
//
// HrTransportRequests already exists (created via create-hr-tables.js's
// model .sync(), which only creates missing tables -- it doesn't alter
// existing ones), so this checks INFORMATION_SCHEMA.COLUMNS per column
// and only ALTERs what's actually missing. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const COLUMNS = [
    { name: "additionalAmount", ddl: "ADD COLUMN `additionalAmount` FLOAT NULL" },
    { name: "additionalAmountNote", ddl: "ADD COLUMN `additionalAmountNote` TEXT NULL" },
    { name: "paidAt", ddl: "ADD COLUMN `paidAt` DATETIME NULL" },
    { name: "paidByUserId", ddl: "ADD COLUMN `paidByUserId` INT NULL" },
];

const run = async () => {
    try {
        const [existing] = await sequelizeUtf8.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HrTransportRequests'
        `);
        const existingNames = new Set(existing.map((r) => r.COLUMN_NAME));

        for (const col of COLUMNS) {
            if (existingNames.has(col.name)) {
                console.log(`⏭️  ${col.name} already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`HrTransportRequests\` ${col.ddl}`);
            console.log(`✅ Added ${col.name}`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add transport payment columns:", err);
        process.exit(1);
    }
};

run();
