// backend/models/MatWhCoatingInvoiceItem.js
// IIT_Petra.matWhCoatingInvoiceItems -- one priced line per coated item on
// Mix's invoice (2026-10-29). Coating is priced per kg: weightKg defaults
// to qty x the variant's unitWeight (kg per bar), but stays editable since
// many variants have no weight on file and Mix weighs the batch itself.
// lineAmt = weightKg x pricePerKg; the invoice's paintingCost is the sum.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhCoatingInvoiceItem = sequelizeUtf8.define('MatWhCoatingInvoiceItem', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    coatingInvoiceId: { type: DataTypes.INTEGER, allowNull: false },
    // The coating job (matWhExternalProcessing row) this line bills for --
    // approval adds the line's amount to that job's item+store cost.
    jobId: { type: DataTypes.INTEGER, allowNull: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    color: { type: DataTypes.STRING(50), allowNull: true },
    lengthMm: { type: DataTypes.FLOAT, allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    weightKg: { type: DataTypes.FLOAT, allowNull: false },
    pricePerKg: { type: DataTypes.FLOAT, allowNull: false },
    lineAmt: { type: DataTypes.FLOAT, allowNull: false },
}, {
    tableName: 'matWhCoatingInvoiceItems',
    timestamps: true,
});
