// backend/models/MatWhItemStore.js
// IIT_Petra.matWhItemStores -- which store(s) an item is actually kept in.
// Many-to-many (a real item can live in more than one store -- verified
// live against Alpha's own movement history, InvDailyDF + InvHistoryDF:
// 1,562 of our items genuinely span more than one store) rather than a
// single storeId column on MatWhItem itself.
//
// Seeded from Alpha's real transaction history (see
// scripts/seed-matwh-item-stores-from-alpha.js) -- an item with no
// evidence in either ledger table simply has no rows here, which the
// reservation flow treats as "store-flexible" (any store selectable),
// never as a guess at which store it "should" be in.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const MatWhItemStore = sequelizeUtf8.define('MatWhItemStore', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    itemId: { type: DataTypes.INTEGER, allowNull: false },
    storeId: { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'matWhItemStores',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['itemId', 'storeId'] },
    ],
});
