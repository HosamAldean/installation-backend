// backend/models/Client.js
// IIT_Petra.client. See Migration Blueprint §07 "Clients" module.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const Client = sequelize2.define('Client', {
    clientId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clientName: { type: DataTypes.STRING, allowNull: true },
}, {
    tableName: 'client',
    timestamps: false,
});

export default Client;
