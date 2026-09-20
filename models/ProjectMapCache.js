// backend/models/ProjectMapCache.js
// Caches the resolved lat/lng for a project's mapAddress once it's been
// followed through Google's redirect (see services/resolveMapLink.js) --
// avoids re-fetching Google's shortener on every Schedule/Team Roster
// load for the same project. Genuinely new concept with no legacy
// Access/ERP equivalent -- sequelizeUtf8, same as InstOrderComponent.js /
// InstTeamVacation.js.
import { DataTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';

export const ProjectMapCache = sequelizeUtf8.define('ProjectMapCache', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    // The mapAddress value that was resolved -- if the ERP's project row
    // later gets a different link, the cache is stale and re-resolved
    // rather than trusted blindly.
    mapAddress: { type: DataTypes.TEXT, allowNull: true },
    coordinates: { type: DataTypes.STRING, allowNull: true },
    // Only set when the resolved Google Maps URL embeds a real place name
    // (see extractPlaceName in services/resolveMapLink.js) -- null for
    // bare coordinate pins, not a failure.
    placeName: { type: DataTypes.STRING, allowNull: true },
    // Reverse-geocoded from coordinates via OpenStreetMap Nominatim (see
    // services/reverseGeocode.js) -- covers the common case where
    // placeName is null (a dropped pin has no name in its URL at all).
    areaName: { type: DataTypes.STRING, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'ProjectMapCache',
    timestamps: false,
});
