// ------------------------------------------------------
// backend/scripts/create-payslip-visibility-table.js
// ------------------------------------------------------
// Creates the PayslipVisibility table (MySQL, sequelizeUtf8) and seeds
// its single row (enabled: false -- off until HR turns it on). Uses the
// model's own .sync() (create-if-missing, non-destructive). Safe to
// re-run.
import { PayslipVisibility } from "../models/PayslipVisibility.js";

const run = async () => {
    try {
        await PayslipVisibility.sync();
        const count = await PayslipVisibility.count();
        if (count === 0) {
            await PayslipVisibility.create({ enabled: false });
            console.log("✅ PayslipVisibility ready (seeded, enabled=false)");
        } else {
            console.log("✅ PayslipVisibility ready (row already exists)");
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create PayslipVisibility table:", err);
        process.exit(1);
    }
};

run();
