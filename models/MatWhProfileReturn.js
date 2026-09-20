// backend/models/MatWhProfileReturn.js
// IIT_Petra.matWhProfileReturns -- material coming back into the Profile
// Store, replacing Stock House's guest.StockBackO/StockBack pair
// (flattened, same reasoning as MatWhProfileReceipt). projectNo is
// optional -- a generic return not tied to a project is allowed, unlike the
// legacy app's "stock"/"Back" sentinel values.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileReturn = sequelizeUtf8.define('MatWhProfileReturn', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: true },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    productionNo: { type: DataTypes.STRING(50), allowNull: true },
    worker: { type: DataTypes.STRING(255), allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    returnedBy: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhProfileReturns',
    timestamps: true,
});
