// backend/models/Order.js
// IIT_Petra.orders — production/manufacturing orders (NOT sales RFQ/PO —
// see Migration Blueprint §07/§09 correction, 2026-07-22). One order is a
// batch of manufacturing work for a specific material department
// (orderTypeId -> orderType: Aluminum, Steel, Glass, Accessories, etc.)
// moving through an approval -> factory -> manufactured -> installed
// pipeline (orderStatusId -> orderStatus), with a GM sign-off step
// (gmNote/gmDate). `deleted` is a soft-delete flag already used by the
// live data — never hard-delete a row, only set deleted=1.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const Order = sequelize2PetraErp.define('Order', {
    orderId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    orderNumber: { type: DataTypes.FLOAT, allowNull: false },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    pmId: { type: DataTypes.INTEGER, allowNull: false },
    orderStatusId: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    orderDesc: { type: DataTypes.TEXT, allowNull: true },
    orderDate: { type: DataTypes.DATE, allowNull: true },
    manufactureStartDate: { type: DataTypes.DATE, allowNull: true },
    manufactureEndDate: { type: DataTypes.DATE, allowNull: true },
    orderTypeId: { type: DataTypes.INTEGER, allowNull: false },
    deleted: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    gmNote: { type: DataTypes.TEXT, allowNull: true },
    gmDate: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
    tableName: 'orders',
    timestamps: false,
});

export default Order;
