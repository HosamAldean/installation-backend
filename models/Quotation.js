// backend/models/Quotation.js
// IIT_Petra.quotations — pricing line items under an offer (68k+ live
// rows), one row per profileSection per quotation choice (qChoiceNo --
// an offer can have multiple pricing choices/revisions). See Migration
// Blueprint §07 "Offers". An offer's effective/best value is
// SUM(price) - SUM(price * qDiscountPerc/100) grouped by (offerId,
// qChoiceNo), MAX per offer -- confirmed via three legacy stored
// procedures (see routes/salesAnalytics.js), not guessed. Verified
// against the live schema (SHOW COLUMNS); `measurmentId` is the real
// (misspelled) column name in the live table, kept as-is rather than
// silently renamed.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const Quotation = sequelize2PetraErp.define('Quotation', {
    quotationId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    offerId: { type: DataTypes.INTEGER, allowNull: false },
    profileSectionId: { type: DataTypes.INTEGER, allowNull: false },
    value: { type: DataTypes.FLOAT, allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 0), allowNull: false },
    measurmentId: { type: DataTypes.INTEGER, allowNull: false },
    qChoiceNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    qDiscountPerc: { type: DataTypes.FLOAT, allowNull: true },
    accPrice: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
    tableName: 'quotations',
    timestamps: false,
});

export default Quotation;
