// backend/models/HrTransportAccompanier.js
// One accompanying employee on an HrTransportRequest (the paper form's
// repeatable "المرافقون" table).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrTransportAccompanier = sequelizeUtf8.define('HrTransportAccompanier', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requestId: { type: DataTypes.BIGINT, allowNull: false },
    empNo: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    reason: { type: DataTypes.STRING(500), allowNull: true },
}, {
    tableName: 'HrTransportAccompaniers',
    timestamps: false,
});
