// ------------------------------------------------------
// backend/scripts/backfill-inst-order-schedule-days.js
// ------------------------------------------------------
// GET /instOrders/team-roster now reads exclusively from
// InstOrderScheduleDays (see models/InstOrderScheduleDay.js) instead of
// instOrders.scheduled_date/team_id directly, so it can show what was
// actually scheduled on any given day rather than whichever value those
// two mutable fields currently hold. Every order that was already
// scheduled BEFORE this change has no row in the new table at all --
// without this backfill, the roster would go blank for all pre-existing
// scheduled work until each one is manually touched again.
//
// This can only ever record each order's CURRENT scheduled_date/team_id --
// if an order was already rescheduled more than once under the old
// single-field model, its earlier days are genuinely gone (that's the exact
// gap this feature closes going forward, not something a backfill can
// recover). Idempotent and safely re-runnable: uses findOrCreate
// (insert-if-missing), never overwrites a row this app has already written.
import { sequelize2 } from "../config/db.js";
import { InstOrderScheduleDay } from "../models/InstOrderScheduleDay.js";
import { toDateOnlyString } from "../utils/dateOnly.js";
import { QueryTypes } from "sequelize";

const run = async () => {
    try {
        await InstOrderScheduleDay.sync();

        const orders = await sequelize2.query(
            `SELECT id, team_id, scheduled_date FROM IIT_Petra.instOrders WHERE team_id IS NOT NULL AND scheduled_date IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );

        let created = 0;
        let alreadyPresent = 0;
        for (const o of orders) {
            const [, wasCreated] = await InstOrderScheduleDay.findOrCreate({
                where: {
                    instOrderId: o.id,
                    date: toDateOnlyString(o.scheduled_date),
                },
                defaults: { teamId: o.team_id },
            });
            if (wasCreated) created++;
            else alreadyPresent++;
        }

        console.log(`✅ Backfill complete: ${created} rows created, ${alreadyPresent} already present (untouched)`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to backfill InstOrderScheduleDays:", err);
        process.exit(1);
    }
};

run();
