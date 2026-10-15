// backend/models/MatWhRequestKey.js
// IIT_Petra.matWhRequestKeys -- one row per client request key already
// applied, so a replayed request (the mobile offline queue resending after
// the server saved it but the reply was lost) is answered as "already done"
// instead of posting stock a second time. The key is written in the same
// transaction as the posting it guards. See services/matWhRequestKeys.js.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhRequestKey = sequelizeUtf8.define('MatWhRequestKey', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    requestKey: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    // What the key was used for, e.g. 'transfer_receive' / 'goods_receipt',
    // and that document's id -- for tracing only.
    action: { type: DataTypes.STRING(40), allowNull: false },
    refId: { type: DataTypes.INTEGER, allowNull: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'matWhRequestKeys',
    timestamps: true,
    updatedAt: false,
});
