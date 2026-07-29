// backend/models/lookupModels.js
// Generic reference-table registry for the Petra Migration Blueprint §07
// "Lookups" module — replaces ~20 near-identical add/get/edit/delete
// classes in Petra's lib/ with one factory + one route file
// (routes/lookups.js) instead of a model per table.
//
// Verified against the live IIT_Petra schema (SHOW COLUMNS) before writing
// this, not guessed from Petra's PHP: all 19 tables below genuinely follow
// the exact `<table>Id` (PK, autoincrement) / `<table>Name` (varchar)
// shape. colorInfo and profileSection do NOT fit that shape (real extra
// columns) and get their own explicit field lists rather than being forced
// through the factory. unitShapes already had its own dedicated model
// (models/unitShapes.js, added 2026-07-09) with different column names
// (descEn/descAr, not Name) — reused here, not redefined.
import { DataTypes } from 'sequelize';
import { sequelize2PetraErp } from '../config/db.js';
import { UnitShape } from './unitShapes.js';

// Plain `<table>Id` / `<table>Name` tables — the factory computes both
// column names from the table name itself, so adding a new one here is a
// one-line change (after confirming its real columns match this shape).
const SIMPLE_LOOKUP_TABLES = [
    'accessoryColor',
    'colorType',
    'contactType',
    'errorNote',
    'errorType',
    'falseceiling',
    'flyscreenColor',
    'flyscreenType',
    'innerSpace',
    'innerThickness',
    'paymentType',
    'shutterBoxSides',
    'unityStage',
    'unityStatus',
    'measurement',
    'glassSpecification',
    'bank',
    'projectStatus',
    'projectType',
    'orderStatus',
    'orderStage',
    'cashFlowStage',
    'offerStatus',
];

function defineSimpleLookup(tableName) {
    const pkField = `${tableName}Id`;
    const nameField = `${tableName}Name`;
    const model = sequelize2PetraErp.define(
        tableName[0].toUpperCase() + tableName.slice(1),
        {
            [pkField]: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            [nameField]: { type: DataTypes.STRING, allowNull: true },
        },
        { tableName, timestamps: false },
    );
    return { model, pkField, nameField };
}

const ColorInfo = sequelize2PetraErp.define('ColorInfo', {
    colorInfoId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    mixCode: { type: DataTypes.STRING, allowNull: true },
    code: { type: DataTypes.STRING, allowNull: true },
    colorDesc: { type: DataTypes.TEXT, allowNull: true },
    colorTypeId: { type: DataTypes.INTEGER, allowNull: true },
    colorImage: { type: DataTypes.STRING, allowNull: true },
}, { tableName: 'colorInfo', timestamps: false });

const ProfileSection = sequelize2PetraErp.define('ProfileSection', {
    profileSectionId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    profileSectionName: { type: DataTypes.STRING, allowNull: true },
    profileSectionDept: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    profileSectionType: { type: DataTypes.STRING, allowNull: true },
    measurementId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, { tableName: 'profileSection', timestamps: false });

// orderTypeName/orderTypeDesc are Arabic/English labels for the same
// production department (e.g. "انتاج المنيوم" / "Aluminum") — see
// Order.js and routes/petraErpOrders.js.
const OrderType = sequelize2PetraErp.define('OrderType', {
    orderTypeId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    orderTypeName: { type: DataTypes.STRING, allowNull: false },
    orderTypeDesc: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    orderTypeDept: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, { tableName: 'orderType', timestamps: false });

// type -> { model, pkField, nameField }. `nameField` is what the generic
// list route sorts/searches by default; routes/lookups.js never needs to
// know per-table specifics beyond this registry.
export const LOOKUP_REGISTRY = {
    ...Object.fromEntries(
        SIMPLE_LOOKUP_TABLES.map((t) => [t, defineSimpleLookup(t)]),
    ),
    colorInfo: { model: ColorInfo, pkField: 'colorInfoId', nameField: 'code' },
    profileSection: { model: ProfileSection, pkField: 'profileSectionId', nameField: 'profileSectionName' },
    unitShapes: { model: UnitShape, pkField: 'unitShapeId', nameField: 'descEn' },
    orderType: { model: OrderType, pkField: 'orderTypeId', nameField: 'orderTypeDesc' },
};

export const LOOKUP_TYPES = Object.keys(LOOKUP_REGISTRY);
