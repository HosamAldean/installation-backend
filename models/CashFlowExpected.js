// backend/models/CashFlowExpected.js
// IIT_Petra.cashFlowExpected — project-level expected-amount entries,
// separate from the stage-based cashFlow/cashFlowDetails flow. Only 10
// live rows at time of writing -- a lightly-used feature, kept simple.
// See Migration Blueprint §07 "Cash Flow".
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CashFlowExpected = sequelize2PetraErp.define('CashFlowExpected', {
    cashFlowExpectedId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    expectedAmount: { type: DataTypes.FLOAT, allowNull: true },
    calculatedExpectedAmount: { type: DataTypes.FLOAT, allowNull: true },
    entryDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    dueDate: { type: DataTypes.DATE, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'cashFlowExpected',
    timestamps: false,
});

export default CashFlowExpected;
