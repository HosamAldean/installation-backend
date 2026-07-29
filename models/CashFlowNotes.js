// backend/models/CashFlowNotes.js
// IIT_Petra.cashFlowNotes — free-text notes tied to a project's cash flow
// (not to a specific stage entry). See Migration Blueprint §07 "Cash Flow".
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CashFlowNotes = sequelize2PetraErp.define('CashFlowNotes', {
    cashFlowNoteId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: true },
    noteDate: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
    note: { type: DataTypes.TEXT, allowNull: true },
    cashFlowNoteUserId: { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'cashFlowNotes',
    timestamps: false,
});

export default CashFlowNotes;
