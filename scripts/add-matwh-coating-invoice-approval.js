// ------------------------------------------------------
// backend/scripts/add-matwh-coating-invoice-approval.js
// ------------------------------------------------------
// Adds the warehouse-side approval workflow to matWhCoatingInvoices
// (models/MatWhCoatingInvoice.js) -- per direct request, "the final cost
// must reflect the price of the original material plus the actual
// painting cost, retaining the original invoice details". Renames the
// original netAmt column to paintingCost (Mix's own submitted charge,
// unchanged in meaning, just named for what it actually is now that a
// second cost field exists alongside it) and adds materialCost (filled
// in by the warehouse, not Mix), totalCost (materialCost + paintingCost,
// computed and stored at approval time), and approvalStatus/approvedBy/
// approvedAt/rejectionReason.
//
// Safe to run even though this table has real rows already (this
// session's own live-tested coating invoices) -- the RENAME preserves
// every existing value under its new name.
//
// Idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same pattern as
// every other add-matwh-*.js script.
import { sequelizeUtf8 } from "../config/db.js";

const columnExists = async (table, column) => {
    const [rows] = await sequelizeUtf8.query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
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
        if (await columnExists("matWhCoatingInvoices", "netAmt") && !(await columnExists("matWhCoatingInvoices", "paintingCost"))) {
            await sequelizeUtf8.query("ALTER TABLE `matWhCoatingInvoices` CHANGE COLUMN `netAmt` `paintingCost` FLOAT NULL");
            console.log("✅ Renamed matWhCoatingInvoices.netAmt -> paintingCost");
        } else {
            console.log("- netAmt->paintingCost rename already done or not applicable, skipping");
        }
        await addColumnIfMissing("matWhCoatingInvoices", "materialCost", "`materialCost` FLOAT NULL");
        await addColumnIfMissing("matWhCoatingInvoices", "totalCost", "`totalCost` FLOAT NULL");
        await addColumnIfMissing("matWhCoatingInvoices", "approvalStatus", "`approvalStatus` VARCHAR(20) NOT NULL DEFAULT 'pending'");
        await addColumnIfMissing("matWhCoatingInvoices", "approvedBy", "`approvedBy` INT NULL");
        await addColumnIfMissing("matWhCoatingInvoices", "approvedAt", "`approvedAt` DATETIME NULL");
        await addColumnIfMissing("matWhCoatingInvoices", "rejectionReason", "`rejectionReason` TEXT NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhCoatingInvoices approval fields:", err);
        process.exit(1);
    }
};

run();
