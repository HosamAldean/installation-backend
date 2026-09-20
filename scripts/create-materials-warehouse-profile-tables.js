// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-profile-tables.js
// ------------------------------------------------------
// Creates the 9 new tables for the Materials Warehouse's Profile Store
// sub-module (replaces Stock House's aluminum-profile workflow). Uses each
// model's own .sync() (create-if-missing, non-destructive), same as
// create-materials-warehouse-tables.js. Safe to re-run.
import { MatWhProfileCatalog } from "../models/MatWhProfileCatalog.js";
import { MatWhProfileAssembly } from "../models/MatWhProfileAssembly.js";
import { MatWhProfileStock } from "../models/MatWhProfileStock.js";
import { MatWhProfileReceipt } from "../models/MatWhProfileReceipt.js";
import { MatWhProfileReservation } from "../models/MatWhProfileReservation.js";
import { MatWhProfileShipment } from "../models/MatWhProfileShipment.js";
import { MatWhProfileReturn } from "../models/MatWhProfileReturn.js";
import { MatWhProfileCoatingBatch } from "../models/MatWhProfileCoatingBatch.js";
import { MatWhProfileTransfer } from "../models/MatWhProfileTransfer.js";
import { MatWhProfileFeasibilityCheck } from "../models/MatWhProfileFeasibilityCheck.js";

const run = async () => {
    try {
        await MatWhProfileCatalog.sync();
        console.log("✅ matWhProfileCatalog ready");
        await MatWhProfileAssembly.sync();
        console.log("✅ matWhProfileAssemblies ready");
        // profileStock FKs to profileCatalog, must be created after it.
        await MatWhProfileStock.sync();
        console.log("✅ matWhProfileStock ready");
        await MatWhProfileReceipt.sync();
        console.log("✅ matWhProfileReceipts ready");
        await MatWhProfileReservation.sync();
        console.log("✅ matWhProfileReservations ready");
        await MatWhProfileShipment.sync();
        console.log("✅ matWhProfileShipments ready");
        await MatWhProfileReturn.sync();
        console.log("✅ matWhProfileReturns ready");
        await MatWhProfileCoatingBatch.sync();
        console.log("✅ matWhProfileCoatingBatches ready");
        await MatWhProfileTransfer.sync();
        console.log("✅ matWhProfileTransfers ready");
        await MatWhProfileFeasibilityCheck.sync();
        console.log("✅ matWhProfileFeasibilityChecks ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create materials warehouse profile tables:", err);
        process.exit(1);
    }
};

run();
