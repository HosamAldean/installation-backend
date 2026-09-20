// backend/models/MatWhProfileReservation.js
// IIT_Petra.matWhProfileReservations -- reserve profile stock for a
// project, replacing Stock House's guest.ReservationO/Reservation pair
// (flattened, same reasoning as MatWhProfileReceipt). `status` lets a
// reservation be released back without deleting the record, so it stops
// counting toward a project's outstanding balance while staying visible in
// history.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhProfileReservation = sequelizeUtf8.define('MatWhProfileReservation', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileStockId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
    projectNo: { type: DataTypes.STRING(50), allowNull: false },
    projectName: { type: DataTypes.STRING(255), allowNull: true },
    projectManager: { type: DataTypes.STRING(255), allowNull: true },
    qty: { type: DataTypes.FLOAT, allowNull: false },
    note: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' }, // active, released
    reservedBy: { type: DataTypes.INTEGER, allowNull: true },
    releasedBy: { type: DataTypes.INTEGER, allowNull: true },
    releasedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'matWhProfileReservations',
    timestamps: true,
});
