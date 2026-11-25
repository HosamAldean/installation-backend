// ------------------------------------------------------
// backend/scripts/create-software-library-table.js
// ------------------------------------------------------
// Creates SoftwareLibraryItems (models/SoftwareLibrary.js) for the IT
// software library page. New, empty table only -- the model's own .sync()
// (create-if-missing, non-destructive), same as create-it-licenses-tables.js.
// Safe to re-run.
import { SoftwareLibraryItem } from "../models/SoftwareLibrary.js";

const run = async () => {
    try {
        await SoftwareLibraryItem.sync();
        console.log("✅ SoftwareLibraryItems ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create the software library table:", err);
        process.exit(1);
    }
};

run();
