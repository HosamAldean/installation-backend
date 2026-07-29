// backend/models/CashFlow.js
// IIT_Petra.cashFlow — a cash-flow stage entry for a project (e.g. "30%
// deposit", "delivery payment"), not a payment itself -- actual money
// movements are cashFlowDetails rows underneath it. See Migration
// Blueprint §07 "Cash Flow" (PH.4). Verified against the live schema
// (SHOW COLUMNS) before writing this, not guessed -- the blueprint's
// original guess at a standalone "payments" table was wrong; payments
// live in cashFlowDetails, one level under this table.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CashFlow = sequelize2PetraErp.define('CashFlow', {
    cashFlowId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    cashFlowStageId: { type: DataTypes.INTEGER, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: true },
    cashFlowNote: { type: DataTypes.TEXT, allowNull: true },
    costPercentage: { type: DataTypes.FLOAT, allowNull: true },
    orderNumber: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'cashFlow',
    timestamps: false,
});

export default CashFlow;
