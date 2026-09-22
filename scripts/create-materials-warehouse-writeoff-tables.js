// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-writeoff-tables.js
// ------------------------------------------------------
// Creates the 4 Material Write-off tables (WM 10-41 request + WM 10-42
// report, header+items each). Uses each model's own .sync() (create-if-
// missing, non-destructive), same pattern as
// create-materials-warehouse-operations-tables.js. Safe to re-run.
import { MatWhWriteoffRequest } from "../models/MatWhWriteoffRequest.js";
import { MatWhWriteoffRequestItem } from "../models/MatWhWriteoffRequestItem.js";
import { MatWhWriteoffReport } from "../models/MatWhWriteoffReport.js";
import { MatWhWriteoffReportItem } from "../models/MatWhWriteoffReportItem.js";

const run = async () => {
    try {
        await MatWhWriteoffRequest.sync();
        console.log("✅ matWhWriteoffRequests ready");
        await MatWhWriteoffRequestItem.sync();
        console.log("✅ matWhWriteoffRequestItems ready");
        await MatWhWriteoffReport.sync();
        console.log("✅ matWhWriteoffReports ready");
        await MatWhWriteoffReportItem.sync();
        console.log("✅ matWhWriteoffReportItems ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create write-off tables:", err);
        process.exit(1);
    }
};

run();
