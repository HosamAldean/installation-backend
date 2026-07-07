//backend/models/instOrderItems.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const InstOrderItems = sequelize2.define("InstOrderItems", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    instOrderId: DataTypes.INTEGER,
    instReqDetId: DataTypes.INTEGER,
    rowId: DataTypes.INTEGER,
    itemName: DataTypes.STRING,
    unitNo: DataTypes.STRING,
    qty: DataTypes.INTEGER,
    height: DataTypes.FLOAT,
    width: DataTypes.FLOAT,
    orderId: DataTypes.INTEGER,
    orderNumber: DataTypes.INTEGER,
    priceUnit: DataTypes.DECIMAL,
    status: DataTypes.STRING
}, {
    tableName: "instOrderItems",
    timestamps: false
});
