// ------------------------------------------------------
// backend/scripts/add-matwh-invoice-landed-cost.js
// ------------------------------------------------------
// Invoice upgrades (2026-10-29):
//   - matWhCoatingInvoiceItems (new): Mix's per-item, per-kg lines
//   - matWhSupplierInvoiceExtras (new): freight/customs/... extra costs
//   - matWhSupplierInvoices: currency, rate, discount, VAT, totals, warnings
//   - matWhSupplierInvoiceItems: poItemId, landedUnitCost
// All new columns are nullable, so existing invoices read as before
// (no currency = JOD at rate 1, landed cost = unit price). Idempotent.
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
        await createTableIfMissing("matWhCoatingInvoiceItems", `
            CREATE TABLE \`matWhCoatingInvoiceItems\` (
                \`id\` INT NOT NULL AUTO_INCREMENT,
                \`coatingInvoiceId\` INT NOT NULL,
                \`jobId\` INT NULL,
                \`itemId\` INT NOT NULL,
                \`color\` VARCHAR(50) NULL,
                \`lengthMm\` FLOAT NULL,
                \`qty\` FLOAT NOT NULL,
                \`weightKg\` FLOAT NOT NULL,
                \`pricePerKg\` FLOAT NOT NULL,
                \`lineAmt\` FLOAT NOT NULL,
                \`createdAt\` DATETIME NOT NULL,
                \`updatedAt\` DATETIME NOT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`matWhCoatingInvoiceItems_invoice\` (\`coatingInvoiceId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        await createTableIfMissing("matWhSupplierInvoiceExtras", `
            CREATE TABLE \`matWhSupplierInvoiceExtras\` (
                \`id\` INT NOT NULL AUTO_INCREMENT,
                \`supplierInvoiceId\` INT NOT NULL,
                \`costType\` VARCHAR(20) NOT NULL,
                \`description\` VARCHAR(255) NULL,
                \`vendorId\` INT NULL,
                \`amount\` FLOAT NOT NULL,
                \`currency\` VARCHAR(10) NOT NULL DEFAULT 'JOD',
                \`exchangeRate\` FLOAT NOT NULL DEFAULT 1,
                \`amountJod\` FLOAT NOT NULL,
                \`createdAt\` DATETIME NOT NULL,
                \`updatedAt\` DATETIME NOT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`matWhSupplierInvoiceExtras_invoice\` (\`supplierInvoiceId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        const invoiceColumns = [
            ["currency", "`currency` VARCHAR(10) NULL"],
            ["exchangeRate", "`exchangeRate` FLOAT NULL"],
            ["discountAmt", "`discountAmt` FLOAT NULL"],
            ["vatRate", "`vatRate` FLOAT NULL"],
            ["vatAmt", "`vatAmt` FLOAT NULL"],
            ["grossAmt", "`grossAmt` FLOAT NULL"],
            ["extraCostsJod", "`extraCostsJod` FLOAT NULL"],
            ["landedTotalJod", "`landedTotalJod` FLOAT NULL"],
            ["priceWarnings", "`priceWarnings` TEXT NULL"],
        ];
        for (const [column, ddl] of invoiceColumns) await addColumnIfMissing("matWhSupplierInvoices", column, ddl);
        await addColumnIfMissing("matWhSupplierInvoiceItems", "poItemId", "`poItemId` INT NULL");
        await addColumnIfMissing("matWhSupplierInvoiceItems", "landedUnitCost", "`landedUnitCost` FLOAT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add invoice landed-cost schema:", err);
        process.exit(1);
    }
};

run();
