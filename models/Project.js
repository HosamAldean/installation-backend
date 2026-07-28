// backend/models/Project.js
// IIT_Petra.project — Petra's project master record. Read-only via LEFT
// JOIN elsewhere (followUp.js, instOrders.js, installationRequests.js) for
// display context; this is the first real CRUD model for it, per the
// Petra Migration Blueprint §07 "Projects" module (PH.1).
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const Project = sequelize2.define('Project', {
    projectId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectNo: { type: DataTypes.STRING, allowNull: true, unique: true },
    projectName: { type: DataTypes.STRING, allowNull: true },
    deliverDate: { type: DataTypes.DATEONLY, allowNull: true },
    contractDate: { type: DataTypes.DATEONLY, allowNull: true },
    contractValNoTax: { type: DataTypes.FLOAT, allowNull: true },
    contractValue: { type: DataTypes.FLOAT, allowNull: true },
    contractModifiedValue: { type: DataTypes.FLOAT, allowNull: true },
    actualDeliveryDate: { type: DataTypes.DATEONLY, allowNull: true },
    contractDeliveryDate: { type: DataTypes.DATEONLY, allowNull: true },
    nomDate: { type: DataTypes.DATEONLY, allowNull: true },
    receivedDate: { type: DataTypes.DATEONLY, allowNull: true },
    reservationDate: { type: DataTypes.DATEONLY, allowNull: true },
    maintenanceDate: { type: DataTypes.DATEONLY, allowNull: true },
    contractModDate: { type: DataTypes.DATEONLY, allowNull: true },
    projectManagerId: { type: DataTypes.INTEGER, allowNull: true },
    clientId: { type: DataTypes.INTEGER, allowNull: true },
    typeId: { type: DataTypes.INTEGER, allowNull: true },
    productTypeId: { type: DataTypes.INTEGER, allowNull: false },
    statusId: { type: DataTypes.INTEGER, allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    mapAddress: { type: DataTypes.TEXT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    statusNotes: { type: DataTypes.TEXT, allowNull: true },
    progress: { type: DataTypes.FLOAT, allowNull: true },
    docTypeId: { type: DataTypes.INTEGER, allowNull: true },
    offerNumber: { type: DataTypes.STRING, allowNull: true },
    alumSample: { type: DataTypes.BOOLEAN, allowNull: true },
    glasSample: { type: DataTypes.BOOLEAN, allowNull: true },
    clientApproval: { type: DataTypes.INTEGER, allowNull: true },
    projectNote: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    buildingTypeId: { type: DataTypes.INTEGER, allowNull: false },
    projectOfferId: { type: DataTypes.INTEGER, allowNull: false },
    changeNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rowDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    contractAcceptanceId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    contractAcceptanceNote: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    AluTax: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16 },
    SteelTax: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 16 },
    billNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    billDate: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: '1970-01-01' },
    billAttention: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    ShBillNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    flagged: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    hidden: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    statAccST: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    totalCost: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
}, {
    tableName: 'project',
    timestamps: false,
});

export default Project;
