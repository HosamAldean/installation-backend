// backend/models/CashFlowDetails.js
// IIT_Petra.cashFlowDetails — the actual payment records under a CashFlow
// stage entry (paymentValue, who paid via which bank/payment type, and
// whether it's been marked paid). See Migration Blueprint §07 "Cash Flow".
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CashFlowDetails = sequelize2PetraErp.define('CashFlowDetails', {
    cashFlowDetailsId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    cashFlowId: { type: DataTypes.INTEGER, allowNull: true },
    paymentValue: { type: DataTypes.FLOAT, allowNull: true },
    steelVal: { type: DataTypes.INTEGER, allowNull: true },
    paymentTypeId: { type: DataTypes.INTEGER, allowNull: true },
    paymentDate: { type: DataTypes.DATEONLY, allowNull: true },
    expectedPaymentDate: { type: DataTypes.DATEONLY, allowNull: true },
    paid: { type: DataTypes.BOOLEAN, allowNull: true },
    bankId: { type: DataTypes.INTEGER, allowNull: true },
    docId: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'cashFlowDetails',
    timestamps: false,
});

export default CashFlowDetails;
