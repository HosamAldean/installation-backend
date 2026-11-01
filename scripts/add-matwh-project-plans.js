// ------------------------------------------------------
// backend/scripts/add-matwh-project-plans.js
// ------------------------------------------------------
// Project material plans (2026-11-01):
//   - matWhProjectPlans (new): one plan per order / phase of a project
//   - matWhProjectPlanItems (new): its material lines + last check snapshot
//   - matWhReservationHeaders.projectPlanId: request raised from a plan
// Nothing existing changes; the new column is nullable. Idempotent.
import { sequelizeUtf8 } from "../config/db.js";

const tableExists = async (table) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table
    `, { replacements: { table } });
    return rows.length > 0;
};

const columnExists = async (table, column) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
};

const createTableIfMissing = async (table, ddl) => {
    if (await tableExists(table)) {
        console.log(`- ${table} already exists, skipping`);
        return;
    }
    await sequelizeUtf8.query(ddl);
    console.log(`✅ Created ${table}`);
};

const addColumnIfMissing = async (table, column, ddl) => {
    if (await columnExists(table, column)) {
        console.log(`- ${table}.${column} already exists, skipping`);
        return;
    }
    await sequelizeUtf8.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`✅ Added ${table}.${column}`);
};

const run = async () => {
    try {
        await createTableIfMissing("matWhProjectPlans", `
            CREATE TABLE \`matWhProjectPlans\` (
                \`id\` INT NOT NULL AUTO_INCREMENT,
                \`planNo\` VARCHAR(20) NOT NULL,
                \`projectId\` INT NOT NULL,
                \`projectNo\` VARCHAR(50) NULL,
                \`projectName\` VARCHAR(255) NULL,
                \`projectManager\` VARCHAR(255) NULL,
                \`orderRef\` VARCHAR(100) NOT NULL,
                \`plannedStartDate\` DATE NULL,
                \`status\` VARCHAR(20) NOT NULL DEFAULT 'draft',
                \`notes\` VARCHAR(500) NULL,
                \`lastCheckedAt\` DATETIME NULL,
                \`createdBy\` INT NULL,
                \`createdAt\` DATETIME NOT NULL,
                \`updatedAt\` DATETIME NOT NULL,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`matWhProjectPlans_planNo\` (\`planNo\`),
                KEY \`matWhProjectPlans_project\` (\`projectId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        await createTableIfMissing("matWhProjectPlanItems", `
            CREATE TABLE \`matWhProjectPlanItems\` (
                \`id\` INT NOT NULL AUTO_INCREMENT,
                \`planId\` INT NOT NULL,
                \`itemId\` INT NOT NULL,
                \`storeId\` INT NULL,
                \`color\` VARCHAR(50) NULL,
                \`lengthMm\` FLOAT NULL,
                \`qtyPlanned\` FLOAT NOT NULL,
                \`neededByDate\` DATE NULL,
                \`notes\` VARCHAR(255) NULL,
                \`checkStatus\` VARCHAR(20) NULL,
                \`checkAvailable\` FLOAT NULL,
                \`checkMill\` FLOAT NULL,
                \`checkIncoming\` FLOAT NULL,
                \`checkAtCoating\` FLOAT NULL,
                \`checkCompeting\` FLOAT NULL,
                \`checkIncomingEta\` DATE NULL,
                \`reservationHeaderId\` INT NULL,
                \`reservationItemId\` INT NULL,
                \`createdAt\` DATETIME NOT NULL,
                \`updatedAt\` DATETIME NOT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`matWhProjectPlanItems_plan\` (\`planId\`),
                KEY \`matWhProjectPlanItems_item\` (\`itemId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        await addColumnIfMissing("matWhReservationHeaders", "projectPlanId", "`projectPlanId` INT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add project plan schema:", err);
        process.exit(1);
    }
};

run();
