// backend/models/CR09Details.js
// IIT_Petra.CR09Details — per-unit specification detail (94k+ live rows),
// tied to a project + a specific masterControl.rowId (glass/aluminum
// color, opening direction, shutter box/cover dimensions, etc.). See
// Migration Blueprint §07 "Control Sheet" (CR09Detail). Real table name
// is CR09Details (plural), not "CR09Detail" as guessed from
// CR09Detail.php's class name.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CR09Details = sequelize2PetraErp.define('CR09Details', {
    CR09DetailId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    rowId: { type: DataTypes.INTEGER, allowNull: true },
    glassId: { type: DataTypes.INTEGER, allowNull: true },
    aluminumColorId: { type: DataTypes.INTEGER, allowNull: true },
    vetilationHole: { type: DataTypes.BOOLEAN, allowNull: true },
    hingedDir: { type: DataTypes.BOOLEAN, allowNull: true },
    slideDir: { type: DataTypes.BOOLEAN, allowNull: true },
    threshold: { type: DataTypes.BOOLEAN, allowNull: true },
    levelDiff: { type: DataTypes.TEXT, allowNull: true },
    sideDepth: { type: DataTypes.TEXT, allowNull: true },
    parapetH: { type: DataTypes.TEXT, allowNull: true },
    positioning: { type: DataTypes.TEXT, allowNull: true },
    dividedShutter: { type: DataTypes.TEXT, allowNull: true },
    shutterCover: { type: DataTypes.TEXT, allowNull: true },
    shutterBoxShoulder: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterBoxSidesId: { type: DataTypes.INTEGER, allowNull: true },
    cr09Note: { type: DataTypes.TEXT, allowNull: true },
    floor: { type: DataTypes.TEXT, allowNull: true },
    shutterBox: { type: DataTypes.TEXT, allowNull: true },
    FFL: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterRollerBarrel: { type: DataTypes.TEXT, allowNull: true },
    shutterCoverWidth: { type: DataTypes.TEXT, allowNull: true },
    shutterCoverHight: { type: DataTypes.TEXT, allowNull: true },
}, {
    tableName: 'CR09Details',
    timestamps: false,
});

export default CR09Details;
