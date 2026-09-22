// backend/models/PayslipVisibility.js
// Single global on/off switch controlling whether employees can see the
// Payslip self-service report at all -- HR-controlled, off by default
// (soft-launch, same convention as PermissionGrant starting empty until
// deliberately opened up). Deliberately a single flag, not per-employee:
// per explicit direction this is "a control button" for the whole
// feature, not a per-account visibility list.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const PayslipVisibility = sequelizeUtf8.define('PayslipVisibility', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'PayslipVisibility',
    timestamps: true,
});
