// ------------------------------------------------------
// backend/scripts/create-matwh-coating-invoices-table.js
// ------------------------------------------------------
// Creates matWhCoatingInvoices -- Mix's (the coating vendor's) own invoice
// for a finished coating request, keyed by requestNo since a coating job
// has no purchaseOrderId to hang off (see models/MatWhCoatingInvoice.js's
// own comment for why this is a separate table from
// matWhSupplierInvoices rather than a loosened FK on it).
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
        if (await tableExists("matWhCoatingInvoices")) {
            console.log("- matWhCoatingInvoices already exists, skipping");
        } else {
            await sequelizeUtf8.query(`
                CREATE TABLE \`matWhCoatingInvoices\` (
                    \`id\` INT NOT NULL AUTO_INCREMENT,
                    \`requestNo\` VARCHAR(50) NOT NULL,
                    \`processVendorId\` INT NULL,
                    \`vendorInvoiceNo\` VARCHAR(100) NOT NULL,
                    \`invDate\` DATE NULL,
                    \`invReceivedDate\` DATETIME NOT NULL,
                    \`invDueDate\` DATE NULL,
                    \`netAmt\` FLOAT NULL,
                    \`notes\` TEXT NULL,
                    \`enteredBy\` INT NULL,
                    \`createdAt\` DATETIME NOT NULL,
                    \`updatedAt\` DATETIME NOT NULL,
                    PRIMARY KEY (\`id\`),
                    KEY \`matWhCoatingInvoices_requestNo\` (\`requestNo\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
            `);
            console.log("✅ Created matWhCoatingInvoices");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create matWhCoatingInvoices:", err);
        process.exit(1);
    }
};

run();
