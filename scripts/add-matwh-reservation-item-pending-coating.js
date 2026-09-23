// ------------------------------------------------------
// backend/scripts/add-matwh-reservation-item-pending-coating.js
// ------------------------------------------------------
// Adds matWhReservationItems.qtyPendingCoating -- follow-up to the coating/
// Mix request work, 2026-09-23, per direct request: a painted-ALM line's
// shortfall should first try to use EXISTING mill-finish (raw) stock
// already sitting in the store (routed straight to a coating request, no
// purchase), before falling back to a brand-new mill-finish PO for
// whatever's still missing. qtyReserved (exact requested color) and
// qtyShortfall (needs a new purchase) already existed but had no bucket for
// "drawn from existing raw stock, sent for coating" -- this is that third
// bucket. See services/matWhReservations.js's confirmOneLine/
// confirmReservation and services/matWhLedger.js's getAlreadyReserved (which
// now also sums this field, from every line regardless of its own color,
// whenever the raw/mill pool itself is being queried -- this qty is always
// drawn from that pool no matter what color the line displays).
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

const run = async () => {
    try {
        if (await columnExists("matWhReservationItems", "qtyPendingCoating")) {
            console.log("- matWhReservationItems.qtyPendingCoating already exists, skipping");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhReservationItems` ADD COLUMN `qtyPendingCoating` FLOAT NOT NULL DEFAULT 0",
            );
            console.log("✅ Added matWhReservationItems.qtyPendingCoating");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhReservationItems.qtyPendingCoating:", err);
        process.exit(1);
    }
};

run();
