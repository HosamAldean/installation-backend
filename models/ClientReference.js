// backend/models/ClientReference.js
// IIT_Petra.clientReference — a named contact person tied to a client,
// optionally scoped to a project/offer. See Migration Blueprint §07.
import { DataTypes } from 'sequelize';
import { sequelize2ClientsProjects } from '../config/db.js';

export const ClientReference = sequelize2ClientsProjects.define('ClientReference', {
    clientReferenceId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clientId: { type: DataTypes.INTEGER, allowNull: false },
    projectId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    clientReferenceName: { type: DataTypes.STRING, allowNull: false },
    jobDesc: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    note: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'clientReference',
    timestamps: false,
});

export default ClientReference;
