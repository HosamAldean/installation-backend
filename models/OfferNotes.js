// backend/models/OfferNotes.js
// IIT_Petra.offerNotes — free-text notes tied to an offer. See Migration
// Blueprint §07 "Offers".
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const OfferNotes = sequelize2PetraErp.define('OfferNotes', {
    offerNotesId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    offerId: { type: DataTypes.INTEGER, allowNull: false },
    offerNotesText: { type: DataTypes.TEXT, allowNull: false },
    offerNotesDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
    tableName: 'offerNotes',
    timestamps: false,
});

export default OfferNotes;
