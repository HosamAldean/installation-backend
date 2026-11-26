// ------------------------------------------------------
// backend/scripts/create-software-deploy-table.js
// ------------------------------------------------------
// Creates SoftwareDeployJobs (models/SoftwareDeployJob.js) for Software
// Library phase 2 (install from the app). New, empty table only -- the
// model's own .sync() (create-if-missing, non-destructive). Safe to re-run.
import { SoftwareDeployJob } from "../models/SoftwareDeployJob.js";

const run = async () => {
    try {
        await SoftwareDeployJob.sync();
        console.log("✅ SoftwareDeployJobs ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create the software deploy table:", err);
        process.exit(1);
    }
};

run();
