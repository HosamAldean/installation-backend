// ------------------------------------------------------
// backend/scripts/add-team-supervisor.js
// ------------------------------------------------------
// Adds supervisor_emp_no to instTeams -- distinct from leader_emp_no
// (the team's own on-site lead, used by the mobile self-assign feature).
// This is the office-side manager responsible for a team, needed to scope
// the installation_supervisor role down to "his teams" instead of every
// team in the company (currently unscoped everywhere: GET /teams,
// /instOrders/assigned-components, /follow-up/team/locations, etc.).
// Nullable -- existing teams have no supervisor assigned until someone
// sets one via the Teams admin UI. Safe to re-run.
import { sequelize2 } from "../config/db.js";

const run = async () => {
    try {
        const [existing] = await sequelize2.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'instTeams' AND COLUMN_NAME = 'supervisor_emp_no'
        `);

        if (existing.length > 0) {
            console.log("⏭️  supervisor_emp_no already exists, skipping");
            process.exit(0);
        }

        await sequelize2.query("ALTER TABLE `instTeams` ADD COLUMN `supervisor_emp_no` INT NULL");
        console.log("✅ Added instTeams.supervisor_emp_no");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to add supervisor_emp_no column:", err);
        process.exit(1);
    }
};

run();
