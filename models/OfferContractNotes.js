// backend/models/OfferContractNotes.js
// IIT_Petra.offerContractNotes — typed notes tied to an offer's contract
// (only 1 live row -- negligible usage, kept simple). See Migration
// Blueprint §07 "Offers" (deferred piece, built as a follow-up).
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const OfferContractNotes = sequelize2PetraErp.define('OfferContractNotes', {
    offerContractNotesId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    offerContractNotesType: { type: DataTypes.STRING, allowNull: false },
    offerContractNotesDesc: { type: DataTypes.TEXT, allowNull: false },
    offerContractNotesDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    offerId: { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'offerContractNotes',
    timestamps: false,
});

export default OfferContractNotes;
