// ------------------------------------------------------
// backend/scripts/add-materials-warehouse-vendor-columns.js
// ------------------------------------------------------
// Extends the existing `vendors` table (vendorId/vendorName/vendorDesc,
// 10 rows, previously untouched by any application code -- confirmed via a
// full grep) with the fields the new Materials Warehouse module needs, per
// the Alpha Warehouse Analysis report §10. Checks INFORMATION_SCHEMA.COLUMNS
// per column and only ALTERs what's missing -- same pattern as
// add-transport-payment-columns.js. Safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

const COLUMNS = [
    { name: "paymentTerms", ddl: "ADD COLUMN `paymentTerms` VARCHAR(100) NULL" },
    { name: "delayDays", ddl: "ADD COLUMN `delayDays` INT NULL" },
    { name: "currency", ddl: "ADD COLUMN `currency` VARCHAR(10) NULL" },
    { name: "country", ddl: "ADD COLUMN `country` VARCHAR(100) NULL" },
    { name: "creditLimit", ddl: "ADD COLUMN `creditLimit` FLOAT NULL" },
    { name: "isActive", ddl: "ADD COLUMN `isActive` TINYINT(1) NOT NULL DEFAULT 1" },
];

const run = async () => {
    try {
        const [existing] = await sequelizeUtf8.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendors'
        `);
        const existingNames = new Set(existing.map((r) => r.COLUMN_NAME));

        for (const col of COLUMNS) {
            if (existingNames.has(col.name)) {
                console.log(`⏭️  ${col.name} already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`vendors\` ${col.ddl}`);
            console.log(`✅ Added ${col.name}`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add materials warehouse vendor columns:", err);
        process.exit(1);
    }
};

run();
