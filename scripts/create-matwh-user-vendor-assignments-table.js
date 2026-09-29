// ------------------------------------------------------
// backend/scripts/create-matwh-user-vendor-assignments-table.js
// ------------------------------------------------------
// Creates matWhUserVendorAssignments -- which user(s) may act on which
// vendor in the new coating-vendor portal (routes/
// materialsWarehouseCoatingVendor.js). See models/
// MatWhUserVendorAssignment.js's own comment for why this table is real
// enforcement, unlike its store-scoped sibling.
//
// Idempotent (checks INFORMATION_SCHEMA.TABLES first), same pattern as
// every other create-matwh-*-table.js script this session.
import { sequelizeUtf8 } from "../config/db.js";

const tableExists = async (table) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table
    `, { replacements: { table } });
    return rows.length > 0;
};

const run = async () => {
    try {
        if (await tableExists("matWhUserVendorAssignments")) {
            console.log("- matWhUserVendorAssignments already exists, skipping");
        } else {
            await sequelizeUtf8.query(`
                CREATE TABLE \`matWhUserVendorAssignments\` (
                    \`id\` INT NOT NULL AUTO_INCREMENT,
                    \`userId\` INT NOT NULL,
                    \`vendorId\` INT NOT NULL,
                    PRIMARY KEY (\`id\`),
                    UNIQUE KEY \`matWhUserVendorAssignments_user_vendor\` (\`userId\`, \`vendorId\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
            `);
            console.log("✅ Created matWhUserVendorAssignments");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create matWhUserVendorAssignments:", err);
        process.exit(1);
    }
};

run();
