// backend/models/MatWhProfileAssembly.js
// IIT_Petra.matWhProfileAssemblies -- a combined/fabricated profile number
// mapped to up to 5 component profile numbers, replacing Stock House's
// guest.ProfileNOA. Admin-maintained catalog data, not store-scoped, same
// as the legacy table.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileAssembly = sequelizeUtf8.define('MatWhProfileAssembly', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    assemblyProfileNo: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    partProfileNo1: { type: DataTypes.STRING(50), allowNull: true },
    partProfileNo2: { type: DataTypes.STRING(50), allowNull: true },
    partProfileNo3: { type: DataTypes.STRING(50), allowNull: true },
    partProfileNo4: { type: DataTypes.STRING(50), allowNull: true },
    partProfileNo5: { type: DataTypes.STRING(50), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
    tableName: 'matWhProfileAssemblies',
    timestamps: true,
});
