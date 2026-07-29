// backend/models/ControlSheetUnit.js
// IIT_Petra.masterControl — Petra's production control-sheet unit record
// (Controlsheet.php in the legacy app, 117k+ live rows). Per Migration
// Blueprint §07 "Control Sheet" (PH.3), the highest-effort module. Models
// all 50 real columns (verified via SHOW COLUMNS, not guessed); the
// frontend/API only expose the fields actually used for day-to-day status
// tracking -- the glass/shutter/spec fields (glassOuterSpecs,
// shutterRail, colLenght, custAngle, ...) are PPC01/CR09Detail-adjacent
// specification data, out of scope for this pass (see routes/
// controlSheet.js header).
//
// routes/petraErpOrders.js already reads this table read-only (order
// item assignment) -- this model is the first real CRUD surface for it.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';

export const ControlSheetUnit = sequelize2PetraErp.define('ControlSheetUnit', {
    rowId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    projectId: { type: DataTypes.INTEGER, allowNull: false },
    orderId: { type: DataTypes.INTEGER, allowNull: true },
    unitIdContract: { type: DataTypes.STRING, allowNull: true },
    unitIdDetail: { type: DataTypes.STRING, allowNull: true },
    productInfoId: { type: DataTypes.INTEGER, allowNull: true },
    profileSectionId: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.FLOAT, allowNull: true },
    width: { type: DataTypes.FLOAT, allowNull: true },
    heightDetail: { type: DataTypes.FLOAT, allowNull: true },
    widthDetail: { type: DataTypes.FLOAT, allowNull: true },
    priceContract: { type: DataTypes.FLOAT, allowNull: true },
    priceModified: { type: DataTypes.FLOAT, allowNull: true },
    priceUnit: { type: DataTypes.FLOAT, allowNull: true },
    finalPrice: { type: DataTypes.FLOAT, allowNull: true },
    tax: { type: DataTypes.FLOAT, allowNull: true },
    masterControlNote: { type: DataTypes.TEXT, allowNull: true },
    // Legacy Controlsheet.php resets any of these five to 0 if a caller
    // sends >100 (addControlSheet/editAllControlSheet) -- see the same
    // clamp reproduced in routes/controlSheet.js. Not a clamp to 100; a
    // full reset to 0, exactly as the PHP does it.
    mResPerc: { type: DataTypes.FLOAT, allowNull: true },
    poPerc: { type: DataTypes.FLOAT, allowNull: true },
    proCompPerc: { type: DataTypes.FLOAT, allowNull: true },
    installCompPerc: { type: DataTypes.FLOAT, allowNull: true },
    finishDelPerc: { type: DataTypes.FLOAT, allowNull: true },
    unityStatusId: { type: DataTypes.INTEGER, allowNull: true },
    unityStageId: { type: DataTypes.INTEGER, allowNull: true },
    measurementValue: { type: DataTypes.FLOAT, allowNull: true },
    measurementId: { type: DataTypes.INTEGER, allowNull: true },
    deleted: { type: DataTypes.BOOLEAN, allowNull: true },
    // Glass/shutter/spec fields -- modeled for completeness, not exposed
    // in the UI/API this pass (see file header).
    glassOuterSpecs: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    glassthicknessF: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    glassInnerSpecs: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    glassthicknessS: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    innerSpace: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    glassGFC: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    shutterRail: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    spacerSpecs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    profNote: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    imageNo: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    colLenght: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    custAngle: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    autoLock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    coverH: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    coverW: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    coverH2: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    movableHeight: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    glassType: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    upstandHeight: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    leafQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lockType: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    mainOpen: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    coverW2: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    unitShapeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
    tableName: 'masterControl',
    timestamps: false,
});

export default ControlSheetUnit;
