// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-operations-tables.js
// ------------------------------------------------------
// Creates the 4 WH.3 tables (Warehouse operations: ledger, reservations,
// feasibility checks, external processing). Uses each model's own .sync()
// (create-if-missing, non-destructive), same pattern as the WH.1/WH.2
// create-tables scripts. Safe to re-run.
import { MatWhStockLedger } from "../models/MatWhStockLedger.js";
import { MatWhReservationHeader } from "../models/MatWhReservationHeader.js";
import { MatWhReservationItem } from "../models/MatWhReservationItem.js";
import { MatWhFeasibilityCheck } from "../models/MatWhFeasibilityCheck.js";
import { MatWhExternalProcessing } from "../models/MatWhExternalProcessing.js";

const run = async () => {
    try {
        await MatWhStockLedger.sync();
        console.log("✅ matWhStockLedger ready");
        await MatWhReservationHeader.sync();
        console.log("✅ matWhReservationHeaders ready");
        await MatWhReservationItem.sync();
        console.log("✅ matWhReservationItems ready");
        await MatWhFeasibilityCheck.sync();
        console.log("✅ matWhFeasibilityChecks ready");
        await MatWhExternalProcessing.sync();
        console.log("✅ matWhExternalProcessing ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create materials warehouse operations tables:", err);
        process.exit(1);
    }
};

run();
