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
    // General location within this one store, for this item's pooled
    // stock -- WH gap #9 (audit: "location tracking exists only for
    // Profile Store, and only Column/Row -- the main item catalog has no
    // location fields at all"). Same field names as MatWhProfileStock's
    // own locationColumn/locationRow for naming consistency only, no
    // relation between the two -- this describes where an item is
    // GENERALLY found in a store's pooled stock, not a specific physical
    // unit's location (System A has no per-unit tracking, unlike Profile
    // Store's barcode-per-piece model). Deleted along with the row when
    // an item-store association is removed (PUT /items/:id/stores) --
    // unchecking a store means "not kept there," its location note goes
    // with it, by direct decision.
    zone: { type: DataTypes.STRING(50), allowNull: true },
    locationColumn: { type: DataTypes.STRING(50), allowNull: true },
    locationRow: { type: DataTypes.STRING(50), allowNull: true },
}, {
    tableName: 'matWhItemStores',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['itemId', 'storeId'] },
    ],
});
