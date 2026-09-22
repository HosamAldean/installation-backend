// backend/models/PermissionGrant.js
// App-wide, admin-editable page/feature permission grants. Replaces
// hardcoded authorizeRoles(...)/authorizeReadWrite(...) arrays across the
// app (see backend/constants/permissions.js for the key list, and
// backend/middleware/permissions.js for how this is checked). One row =
// one role granted one permission key. `admin` never needs a row here —
// it's a hardcoded bypass in the middleware, not data, so an empty/corrupt
// table can never lock admin out of its own grant screen.
// Not registered in models/index.js: like User.js/Project.js/Client.js,
// this is used directly by its own middleware/route files.
//
// Started as Petra-ERP-only (table PetraErpRoleGrants); renamed/generalized
// before merge to cover every module, since the mechanism was always
// generic and nothing outside this branch depended on the old name yet.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const PermissionGrant = sequelize2.define(
    'PermissionGrant',
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        role: {
            type: DataTypes.STRING(64),
            allowNull: false,
        },
        permissionKey: {
            type: DataTypes.STRING(64),
            allowNull: false,
            field: 'permissionKey',
        },
        grantedByUserId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            field: 'grantedByUserId',
        },
    },
    {
        tableName: 'PermissionGrants',
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['role', 'permissionKey'],
            },
        ],
    }
);
