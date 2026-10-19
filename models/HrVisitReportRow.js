// backend/models/HrVisitReportRow.js
// One visit on an HrVisitReport -- a row of the paper form's table:
// time [from - to], the party visited, the reason, and who asked for it.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrVisitReportRow = sequelizeUtf8.define('HrVisitReportRow', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requestId: { type: DataTypes.BIGINT, allowNull: false },
    fromTime: { type: DataTypes.STRING(5), allowNull: false },
    toTime: { type: DataTypes.STRING(5), allowNull: false },
    // "الجهة التي تم زيارتها"
    visitedParty: { type: DataTypes.STRING(255), allowNull: false },
    // "سبب الزيارة"
    visitReason: { type: DataTypes.STRING(500), allowNull: false },
    // "بناءً على طلب من"
    requestedBy: { type: DataTypes.STRING(255), allowNull: true },
}, {
    tableName: 'HrVisitReportRows',
    timestamps: false,
});
