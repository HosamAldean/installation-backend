// backend/models/InstOrders.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrders = sequelize2.define('InstOrders', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    instReqMasterId: { type: DataTypes.BIGINT, allowNull: true },
    team_id: { type: DataTypes.INTEGER, allowNull: true },
    order_number: { type: DataTypes.INTEGER, allowNull: false },
    unitIdContract: { type: DataTypes.BIGINT, allowNull: true },
    // Matches the live DB enum/default (previously declared only 3 of the 5
    // real values, with the wrong default — would have thrown if this model
    // were ever used to create/update a row with a real status value).
    status: { type: DataTypes.ENUM('assigned', 'pending', 'in_progress', 'done', 'cancelled'), defaultValue: 'assigned' },
    assigned_date: { type: DataTypes.DATE, allowNull: true },
    scheduled_date: { type: DataTypes.DATE, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'instOrders',
    timestamps: false
});
