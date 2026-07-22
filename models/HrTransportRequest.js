// backend/models/HrTransportRequest.js
// Digitized version of HR form 10-34 (work departure / transportation
// allowance request). The only one of the 3 forms with a Finance approval
// stage -- kmRate/totalAmount are filled in by Finance at approval time
// (matching the paper form exactly), not a fixed system-wide rate.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const HrTransportRequest = sequelizeUtf8.define('HrTransportRequest', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    requesterUserId: { type: DataTypes.INTEGER, allowNull: false },
    requesterEmpNo: { type: DataTypes.INTEGER, allowNull: false },
    projectLabel: { type: DataTypes.STRING(255), allowNull: true },
    visitReason: { type: DataTypes.TEXT, allowNull: true },
    departureDate: { type: DataTypes.DATEONLY, allowNull: false },
    departureTime: { type: DataTypes.STRING(5), allowNull: true },
    returnTime: { type: DataTypes.STRING(5), allowNull: true },
    transportMethod: { type: DataTypes.ENUM('private_car', 'public_transport'), allowNull: false },
    kmDriven: { type: DataTypes.FLOAT, allowNull: true },
    farePaid: { type: DataTypes.FLOAT, allowNull: true },
    status: {
        type: DataTypes.ENUM(
            'pending_manager',
            'pending_hr_audit',
            'pending_finance',
            'approved',
            'rejected',
        ),
        allowNull: false,
        defaultValue: 'pending_manager',
    },
    managerApproverEmpNo: { type: DataTypes.INTEGER, allowNull: true },
    managerDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    managerDecidedAt: { type: DataTypes.DATE, allowNull: true },
    managerNote: { type: DataTypes.TEXT, allowNull: true },
    hrAuditorUserId: { type: DataTypes.INTEGER, allowNull: true },
    hrDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    hrDecidedAt: { type: DataTypes.DATE, allowNull: true },
    hrNote: { type: DataTypes.TEXT, allowNull: true },
    financeApproverUserId: { type: DataTypes.INTEGER, allowNull: true },
    financeDecision: { type: DataTypes.ENUM('approved', 'rejected'), allowNull: true },
    financeDecidedAt: { type: DataTypes.DATE, allowNull: true },
    financeNote: { type: DataTypes.TEXT, allowNull: true },
    kmRate: { type: DataTypes.FLOAT, allowNull: true },
    totalAmount: { type: DataTypes.FLOAT, allowNull: true },
    // Manual top-up Finance can add on top of the km/fare calculation
    // (bonus, correction, extra allowance) -- folded into totalAmount at
    // approval time, kept separately too so the breakdown stays visible.
    additionalAmount: { type: DataTypes.FLOAT, allowNull: true },
    additionalAmountNote: { type: DataTypes.TEXT, allowNull: true },
    // Separate from financeDecision/status: "approved" means Finance signed
    // off on the amount, "paid" means Accounting confirms it was actually
    // disbursed -- two different real-world events, so they're two
    // different fields rather than folding "paid" into the status enum.
    paidAt: { type: DataTypes.DATE, allowNull: true },
    paidByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'HrTransportRequests',
    timestamps: true,
});
