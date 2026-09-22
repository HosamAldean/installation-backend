// backend/models/MatWhProfileShipment.js
// IIT_Petra.matWhProfileShipments -- material physically leaving the
// Profile Store for a project, replacing Stock House's
// guest.StockOutO/StockOut pair (flattened, same reasoning as
// MatWhProfileReceipt).
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileShipment = sequelizeUtf8.define('MatWhProfileShipment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: false },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    productionNo: { type: DataTypes.STRING(50), allowNull: true },
    worker: { type: DataTypes.STRING(255), allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    shippedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileShipments',
    timestamps: true,
});
