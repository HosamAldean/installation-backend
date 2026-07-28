// backend/models/ArchOffice.js
// IIT_Petra.archOffice — architect offices, grouped under the Clients
// module per Migration Blueprint §07 rather than given its own module.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const ArchOffice = sequelize2PetraErp.define('ArchOffice', {
    archOfficeId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    archOfficeName: { type: DataTypes.STRING, allowNull: false },
    archOfficeNameAr: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    archOfficeDesc: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    archAddress: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    archInfo: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    gmap: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
}, {
    tableName: 'archOffice',
    timestamps: false,
});

export default ArchOffice;
