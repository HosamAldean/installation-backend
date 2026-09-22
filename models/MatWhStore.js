// backend/models/MatWhStore.js
// IIT_Petra.matWhStores -- physical warehouse/store master for the new
// Materials Warehouse module (WH.1), replacing both Stock House and
// Alpha's warehouse/purchasing functions per the sign-off in the Alpha
// Warehouse Analysis report. Modeled after Alpha's InvStoresMF, sized down
// to what this module actually needs.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhStore = sequelizeUtf8.define('MatWhStore', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    storeCode: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    storeName: { type: DataTypes.STRING(100), allowNull: false },
    storeNameAr: { type: DataTypes.STRING(100), allowNull: true },
    // Free string, not a DB enum -- e.g. 'production', 'staging',
    // 'reservation' -- mirrors the loose typing already used across this
    // codebase's other role/status-like fields (see InsUser.role).
    storeType: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'production' },
    location: { type: DataTypes.STRING(255), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhStores',
    timestamps: false,
});
