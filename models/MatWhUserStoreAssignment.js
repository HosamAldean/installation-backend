// backend/models/MatWhUserStoreAssignment.js
// IIT_Petra.matWhUserStoreAssignments -- which users may act on which
// stores. A join table rather than Stock House's single `assignedStore`
// column (see models/User.js) so one user can cover more than one store --
// the improvement flagged in the Alpha Warehouse Analysis report §10.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhUserStoreAssignment = sequelizeUtf8.define('MatWhUserStoreAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    // Free string, room for 'full'/'readonly' etc. later -- not enforced
    // yet, no consumer needs more than presence-of-row in WH.1.
    scope: { type: DataTypes.STRING(30), allowNull: true },
}, {
    tableName: 'matWhUserStoreAssignments',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['userId', 'storeId'] },
    ],
});
