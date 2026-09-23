// ------------------------------------------------------
// backend/scripts/add-matwh-external-processing-request-no.js
// ------------------------------------------------------
// Adds matWhExternalProcessing.requestNo -- direct request, 2026-09-23:
// "the coating request need... auto request no[,] like the purchase
// orders" (MatWhPurchaseOrder.poNo's own auto-generated PO-AUTO-000123
// pattern). Every coating/external-processing job now gets one, generated
// server-side (never typed by hand, same rationale as an auto-PO's own
// number) via the same collision-proof create-with-placeholder-then-rename
// helper matWhReservations.js's PO numbering already uses.
//
// Backfills existing rows (if any) with a generated number too, so nothing
// shows blank in the UI -- also idempotent (only touches rows where
// requestNo IS NULL, safe to re-run).
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
        if (await columnExists("matWhExternalProcessing", "requestNo")) {
            console.log("- matWhExternalProcessing.requestNo already exists, skipping column add");
        } else {
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhExternalProcessing` ADD COLUMN `requestNo` VARCHAR(50) NULL",
            );
            await sequelizeUtf8.query(
                "ALTER TABLE `matWhExternalProcessing` ADD UNIQUE INDEX `matWhExternalProcessing_requestNo` (`requestNo`)",
            );
            console.log("✅ Added matWhExternalProcessing.requestNo (unique)");
        }

        const [rows] = await sequelizeUtf8.query(
            "SELECT id FROM `matWhExternalProcessing` WHERE requestNo IS NULL ORDER BY id ASC",
        );
        for (const row of rows) {
            const requestNo = `COAT-${String(row.id).padStart(6, "0")}`;
            await sequelizeUtf8.query(
                "UPDATE `matWhExternalProcessing` SET requestNo = :requestNo WHERE id = :id",
                { replacements: { requestNo, id: row.id } },
            );
        }
        if (rows.length) console.log(`✅ Backfilled requestNo for ${rows.length} existing row(s)`);
        else console.log("- No existing rows needed backfilling");

        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add matWhExternalProcessing.requestNo:", err);
        process.exit(1);
    }
};

run();
