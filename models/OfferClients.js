// backend/models/OfferClients.js
// IIT_Petra.offerClients — links a client to an offer with an optional
// note (an offer can involve more than one client contact). See
// Migration Blueprint §07 "Offers".
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const OfferClients = sequelize2PetraErp.define('OfferClients', {
    offerClientsId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    offerId: { type: DataTypes.INTEGER, allowNull: false },
    clientId: { type: DataTypes.INTEGER, allowNull: false },
    offerClientsNote: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
}, {
    tableName: 'offerClients',
    timestamps: false,
});

export default OfferClients;
