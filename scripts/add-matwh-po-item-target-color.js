// ------------------------------------------------------
// backend/scripts/add-matwh-po-item-target-color.js
// ------------------------------------------------------
// Adds `targetColor` to matWhPurchaseOrderItems (models/
// MatWhPurchaseOrderItem.js) -- Phase 3 of the 2026-09-22 Materials
// Warehouse capability audit's mill-finish coating workflow. When a
// painted-color reservation line has a shortfall, the auto-generated PO
// item now requests the item MILL-FINISH (color: null -- what's actually
// being procured) while this new field remembers what color it needs to
// become once coated (see services/matWhReservations.js's confirmOneLine/
// confirmReservation). Only ever set by that auto-routing logic -- not
// exposed on the manual "Add Item" PO form. Plain ALTER on an existing
// table, idempotent (checks INFORMATION_SCHEMA.COLUMNS first), same
// pattern as every other add-matwh-*.js script.
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
        await addColumnIfMissing("matWhPurchaseOrderItems", "targetColor", "`targetColor` VARCHAR(50) NULL");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhPurchaseOrderItems.targetColor:", err);
        process.exit(1);
    }
};

run();
