// ------------------------------------------------------
// backend/scripts/add-po-reservation-project-info.js
// ------------------------------------------------------
// Adds project/reservation context to matWhPurchaseOrders (so an
// auto-generated PO shows which reservation/project it came from, not just
// a bare vendor+item list) and a per-line neededByDate to
// matWhPurchaseOrderItems, carried over from the reservation line that
// raised it. Checks before every ALTER -- safe to re-run.
import { sequelizeUtf8 } from "../config/db.js";

async function columnExists(table, column) {
    const [rows] = await sequelizeUtf8.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column
    `, { replacements: { table, column } });
    return rows.length > 0;
}

const PO_COLUMNS = [
    { name: "sourceReservationId", ddl: "ADD COLUMN `sourceReservationId` INT NULL" },
    { name: "projectId", ddl: "ADD COLUMN `projectId` INT NULL" },
    { name: "projectNo", ddl: "ADD COLUMN `projectNo` VARCHAR(50) NULL" },
    { name: "projectName", ddl: "ADD COLUMN `projectName` VARCHAR(255) NULL" },
    { name: "notes", ddl: "ADD COLUMN `notes` VARCHAR(500) NULL" },
];

const run = async () => {
    try {
        for (const col of PO_COLUMNS) {
            if (await columnExists('matWhPurchaseOrders', col.name)) {
                console.log(`⏭️  matWhPurchaseOrders.${col.name} already exists, skipping`);
                continue;
            }
            await sequelizeUtf8.query(`ALTER TABLE \`matWhPurchaseOrders\` ${col.ddl}`);
            console.log(`✅ Added matWhPurchaseOrders.${col.name}`);
        }

        if (await columnExists('matWhPurchaseOrderItems', 'neededByDate')) {
            console.log('⏭️  matWhPurchaseOrderItems.neededByDate already exists, skipping');
        } else {
            await sequelizeUtf8.query("ALTER TABLE `matWhPurchaseOrderItems` ADD COLUMN `neededByDate` DATE NULL");
            console.log('✅ Added matWhPurchaseOrderItems.neededByDate');
        }

        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
};

run();
