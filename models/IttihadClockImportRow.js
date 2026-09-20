// backend/models/IttihadClockImportRow.js
// Staging row for Ittihad company (CompNo=10 in the ERP's SQL Server `DB`
// database) clock punches, imported from the Realand RAMS ("RAS.exe")
// access-control system's exported log (User ID / Clock Time / Att. Type).
// HR reviews/edits inTime/outTime here before confirming, at which point
// the row is written to [DB].[dbo].[TA_EmpTimeSheet] (CompNo=10) on the
// `erp` SQL Server pool -- see routes/ittihadAttendance.js. Lives on
// sequelizeUtf8 (MySQL), same connection as the other HR self-service
// tables, since it's app-local staging state with no ERP equivalent.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const IttihadClockImportRow = sequelizeUtf8.define('IttihadClockImportRow', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    empNo: { type: DataTypes.INTEGER, allowNull: false },
    workDate: { type: DataTypes.DATEONLY, allowNull: false },
    // 24h "HH:MM", editable by HR -- converted to TA_EmpTimeSheet's own
    // right-padded 12h "  H:MMAM" format only at confirm time.
    inTime: { type: DataTypes.STRING(5), allowNull: true },
    outTime: { type: DataTypes.STRING(5), allowNull: true },
    // JSON array of every raw punch that fed this row ({ time: 'HH:MM',
    // type: 'In'|'Out'|... }), kept for HR to see what the device actually
    // reported when deciding whether to trust/override inTime/outTime.
    rawPunches: { type: DataTypes.TEXT, allowNull: true },
    isEdited: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    importedByUserId: { type: DataTypes.INTEGER, allowNull: false },
    postedAt: { type: DataTypes.DATE, allowNull: true },
    postedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    // Bookkeeping for "delete posted" (undo): whether confirm INSERTed a
    // brand-new TA_EmpTimeSheet row (safe to fully DELETE on undo) vs
    // UPDATEd a row that already existed for other reasons (undo must only
    // null back out the specific fields we wrote, never drop the row) --
    // and whether the shift-schedule fields (ShiftNo/Prog_IN/Prog_Out/
    // ShiftHrs/Daily_Prog) were part of that write at all. Both null until
    // the row is actually posted.
    postedAsNewRow: { type: DataTypes.BOOLEAN, allowNull: true },
    postedShiftFields: { type: DataTypes.BOOLEAN, allowNull: true },
}, {
    tableName: 'IttihadClockImportRows',
    timestamps: true,
    indexes: [
        { unique: true, fields: ['empNo', 'workDate'] },
    ],
});
