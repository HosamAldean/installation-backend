// backend/models/OfferChanges.js
// IIT_Petra.offerChanges — glass/coating change requests per offer
// revision (8,415 live rows), with an approval flag. See Migration
// Blueprint §07 "Offers" (deferred piece, built as a follow-up). Verified
// against the live schema (SHOW COLUMNS) -- `offerChangesNote` is
// genuinely INT, not text, in the live table; kept as-is rather than
// silently "fixed" to a string, matching this table's real shape.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const OfferChanges = sequelize2PetraErp.define('OfferChanges', {
    offerChangesId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    offerId: { type: DataTypes.INTEGER, allowNull: false },
    changeNo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    glassTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    coatingTypeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerChangesNote: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    offerApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
    tableName: 'offerChanges',
    timestamps: false,
});

export default OfferChanges;
