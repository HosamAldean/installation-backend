// backend/models/User.js
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const User = sequelize2.define(
    'User',
    {
        userId: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },

        username: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },

        password: {
            type: DataTypes.STRING,
            allowNull: false,
        },

        email: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        avatarUrl: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        role: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'user',
        },

        firstName: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        lastName: {
            type: DataTypes.STRING,
            allowNull: true,
        },

        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
        },

        // ✅ REQUIRED FOR MY-ORDERS
        assignedEmpNo: {
            type: DataTypes.INTEGER,
            allowNull: true,
            field: 'assignedEmpNo', // DB column
        },

        // ✅ Team mapping
        teamId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            field: 'teamId',
        },

        // Session presence (distinct from `active`, which means "account
        // enabled") — set true on login, false on explicit logout, used for
        // the manager dashboard's online/offline indicator.
        isOnline: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            field: 'isOnline',
        },

        lastSeenAt: {
            type: DataTypes.DATE,
            allowNull: true,
            field: 'lastSeenAt',
        },
    },
    {
        tableName: 'InsUser',
        timestamps: false,
    }
);
