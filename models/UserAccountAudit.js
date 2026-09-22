// backend/models/UserAccountAudit.js
// Append-only history of security/privilege-relevant account changes --
// backs the admin-only Audit Log's User Account Changes section. Only
// covers create/role-change/activate/deactivate/password-reset/delete --
// deliberately NOT self-service profile edits (firstName/lastName/email/
// avatarUrl via PATCH /users/:id), which aren't security-relevant and
// would just add noise to a log meant for "who changed someone's access."
// targetUsername is denormalized (kept even after the account itself is
// deleted) for the same reason LoginAudit.username is: the row must
// survive independently of whether targetUserId still resolves to a real
// account.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const UserAccountAudit = sequelize2.define('UserAccountAudit', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    targetUserId: { type: DataTypes.INTEGER, allowNull: true },
    targetUsername: { type: DataTypes.STRING, allowNull: false },
    action: {
        type: DataTypes.ENUM(
            'created',
            'role_changed',
            'activated',
            'deactivated',
            'password_reset',
            'deleted',
        ),
        allowNull: false,
    },
    oldValue: { type: DataTypes.STRING, allowNull: true },
    newValue: { type: DataTypes.STRING, allowNull: true },
    performedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'UserAccountAudits',
    timestamps: true,
    updatedAt: false,
});
