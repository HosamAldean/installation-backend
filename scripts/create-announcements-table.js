// ------------------------------------------------------
// backend/scripts/create-announcements-table.js
// ------------------------------------------------------
// Creates the Announcements table (MySQL, sequelize2). See models/
// Announcement.js for the field rationale. Uses the model's own .sync()
// (create-if-missing, non-destructive). Safe to re-run.
import { Announcement } from "../models/Announcement.js";

const run = async () => {
    try {
        await Announcement.sync();
        console.log("✅ Announcements ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create Announcements table:", err);
        process.exit(1);
    }
};

run();
