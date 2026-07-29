// backend/models/Lead.js
// IIT_Petra.leads — sales inquiry leads, before they become a real offer
// (only 25 live rows -- a lightly-used feature). See Migration Blueprint
// §07 "Offers" (leads.tsx listed as a separate page). Verified against
// the live schema (SHOW COLUMNS), not guessed.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const Lead = sequelize2PetraErp.define('Lead', {
    leadId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    leadName: { type: DataTypes.STRING, allowNull: false },
    leadEmail: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    leadDate: { type: DataTypes.DATEONLY, allowNull: false },
    reqSourceType: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    reqSourceId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reqMethod: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    gmap: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    locId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    productGeneralDesc: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    projectTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    productTypes: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    thermalIns: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    glassType: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    estimatedVal: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    timeFrame: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    leadStatus: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    assignToId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    action: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    actionDate: { type: DataTypes.DATEONLY, allowNull: true },
    reqType: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
}, {
    tableName: 'leads',
    timestamps: false,
});

export default Lead;
