// backend/models/Offer.js
// IIT_Petra.offers — Petra's quotation/offer master record (offers.php in
// the legacy app, ~140 methods across 6+ sub-domains per Migration
// Blueprint §07 "Offers"). This models the core entity only; the actual
// pricing line items (table `quotations`, 68k+ rows) are NOT modeled here
// -- deliberately deferred, see routes/offers.js header. Verified against
// the live schema (SHOW COLUMNS), not guessed. `*Sudan`/`*Ittihad`
// duplicate tables (offersSudan, offersIttihad) exist but are not modeled
// -- per the blueprint, that tenant duplication doesn't carry over.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const Offer = sequelize2PetraErp.define('Offer', {
    offerId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    revDiff: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerNumber: { type: DataTypes.INTEGER, allowNull: false },
    offerName: { type: DataTypes.STRING, allowNull: false },
    changeNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    projectName: { type: DataTypes.STRING, allowNull: false },
    clientId: { type: DataTypes.INTEGER, allowNull: false },
    archOfficeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerTaxPerc: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    inquiryDate: { type: DataTypes.DATEONLY, allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    sentToClientDate: { type: DataTypes.DATEONLY, allowNull: false },
    sentToProjectDate: { type: DataTypes.DATEONLY, allowNull: true },
    expectedDate: { type: DataTypes.DATEONLY, allowNull: false },
    estimatorId: { type: DataTypes.INTEGER, allowNull: true },
    salesPersonId: { type: DataTypes.INTEGER, allowNull: true },
    buildingTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerNote: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    offerStatusId: { type: DataTypes.INTEGER, allowNull: false },
    qChoiceNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    coatingTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    locationId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerRatePerc: { type: DataTypes.INTEGER, allowNull: true },
    competitorId: { type: DataTypes.INTEGER, allowNull: true },
    lossCause: { type: DataTypes.TEXT, allowNull: true },
    xSalesPerson: { type: DataTypes.INTEGER, allowNull: true, field: 'x-salesPerson' },
    signExDate: { type: DataTypes.DATEONLY, allowNull: false },
    offerSpecialDiscount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerType: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    steelOfferId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    enquiryTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    onHoldReason: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastUpdated: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    generalDesc: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'offers',
    timestamps: false,
});

export default Offer;
