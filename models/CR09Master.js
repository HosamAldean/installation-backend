// backend/models/CR09Master.js
// IIT_Petra.CR09Master — one project-level specification preset per
// project (color, glass (DG/SG), shutter, accessory, security, false
// ceiling). See Migration Blueprint §07 "Control Sheet" (CR09). Real
// table name is CR09Master, not "CR09" as guessed from CR09.php's class
// name -- verified via SHOW TABLES/COLUMNS before writing this.
//
// This is the project-level record; per-unit specification detail lives
// in CR09Details (see CR09Details.js), which ties to a specific
// masterControl.rowId. The unit-tagging tables (motorUnitCR09,
// shutterBoxUnitCR09, shutterCoverUnitCR09, shutterUnitCR09 -- which unit
// contract IDs have a motor/shutter-box/shutter-cover/shutter feature)
// are NOT modeled here -- a further deferral, disclosed in routes/cr09.js.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const CR09Master = sequelize2PetraErp.define('CR09Master', {
    CR09Id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    colorInfoId: { type: DataTypes.INTEGER, allowNull: true },
    sheetCladdingColorId: { type: DataTypes.INTEGER, allowNull: true },
    steelColorId: { type: DataTypes.INTEGER, allowNull: true },
    alucobondColorId: { type: DataTypes.INTEGER, allowNull: true },
    flyscreenTypeId: { type: DataTypes.INTEGER, allowNull: true },
    flyscreenColorId: { type: DataTypes.INTEGER, allowNull: true },
    dgGlassInnerSpecificationId: { type: DataTypes.INTEGER, allowNull: true },
    dgInnerSpaceId: { type: DataTypes.INTEGER, allowNull: true },
    dgInnerThicknessId: { type: DataTypes.INTEGER, allowNull: true },
    dgOuterThicknessId: { type: DataTypes.INTEGER, allowNull: true },
    dgGlassOuterSpecificationId: { type: DataTypes.INTEGER, allowNull: true },
    sgGlassSpecificationId: { type: DataTypes.INTEGER, allowNull: true },
    sgGlassSpaceId: { type: DataTypes.INTEGER, allowNull: true },
    sgThicknessId: { type: DataTypes.INTEGER, allowNull: true },
    accessoryColorId: { type: DataTypes.INTEGER, allowNull: true },
    shutterFoam: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterExtruded: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterCurved: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterColorId: { type: DataTypes.INTEGER, allowNull: true },
    shutterInnerRails: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterOuterRails: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterStraight: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterRailsColorId: { type: DataTypes.INTEGER, allowNull: true },
    securityId: { type: DataTypes.INTEGER, allowNull: true },
    falseceilingId: { type: DataTypes.INTEGER, allowNull: true },
    cr09Status: { type: DataTypes.BOOLEAN, allowNull: true },
    deleted: { type: DataTypes.BOOLEAN, allowNull: true },
    shutterColorSecId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    shutterRailsColorSecId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
    tableName: 'CR09Master',
    timestamps: false,
});

export default CR09Master;
