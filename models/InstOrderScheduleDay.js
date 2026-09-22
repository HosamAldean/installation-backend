// backend/models/InstOrderScheduleDay.js
// One row per (order, day) a team was actually scheduled to a project --
// the history instOrders.team_id/scheduled_date alone can't provide, since
// those are single mutable fields that get overwritten the moment a
// project rolls over to the next day or gets reassigned. Written alongside
// (never instead of) instOrders.team_id/scheduled_date and
// instReqAssignments.teamId, which stay the source of truth for who
// currently owns the work (mobile visibility, follow-up, everything else)
// -- this table is purely the day-by-day roster/planning trail. Genuinely
// new concept with no legacy Access/ERP equivalent, sequelizeUtf8 same as
// InstTeamVacation.js/ProjectMapCache.js.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const InstOrderScheduleDay = sequelizeUtf8.define('InstOrderScheduleDay', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instOrderId: { type: DataTypes.INTEGER, allowNull: false },
    teamId: { type: DataTypes.INTEGER, allowNull: false },
    // DATEONLY, not DATE -- this is a calendar day, not a timestamp
    // (matches InstTeamVacation.vacationDate).
    date: { type: DataTypes.DATEONLY, allowNull: false },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'InstOrderScheduleDays',
    timestamps: false,
    indexes: [
        // One team per order per day -- if a different team takes over,
        // that's an update to THIS day's row, not a second row for the
        // same (order, date). A different day (continuation, or later
        // reassignment) is always a separate row, which is the whole point.
        { unique: true, fields: ['instOrderId', 'date'] },
    ],
});
