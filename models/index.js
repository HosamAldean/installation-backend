// --------------------------------------
// IMPORT MODELS
// --------------------------------------

import { User } from "./User.js";
import { InstOrders } from "./InstOrders.js";
import { InstOrderDetails } from "./InstOrderDetails.js";

import { InstSteps } from "./InstSteps.js";  // master steps
import { InstOrderStepUpdates } from "./instOrderStepUpdates.js";

import { InstOrderItems } from "./InstOrderItems.js";   // NEW
import { InstOrderSteps } from "./InstOrderSteps.js";   // NEW

import { InstOrderHolds } from "./instOrderHolds.js";
import { InstTeamCheckpoints } from "./instTeamCheckpoints.js";
import { InstTeams } from "./InstTeams.js";
import { FollowUpNotes } from "./FollowUpNotes.js";


// --------------------------------------
// EXPORT MODELS
// --------------------------------------
export {
    User,
    InstOrders,
    InstOrderDetails,
    InstSteps,
    InstOrderStepUpdates,
    InstOrderItems,
    InstOrderSteps,
    InstOrderHolds,
    InstTeamCheckpoints,
    InstTeams,
    FollowUpNotes
};


/**
 * =====================================================
 *   FIXED & VERIFIED RELATIONSHIPS — FINAL SCHEMA
 * =====================================================
 *
 *  instOrders.id → instOrderDetails.instOrderId
 *  instOrders.id → instOrderItems.instOrderId
 *
 *  instOrderItems.id → instOrderSteps.instOrderItemId
 *
 *  instOrderSteps.instStepId → instSteps.instStepId  (master steps)
 *
 *  instOrderStepUpdates.instOrderStepId → instOrderSteps.id
 *
 *  instTeamCheckpoints.team_id → instTeams.id
 *  instTeamCheckpoints.order_id → instOrders.id
 *
 *  instOrderHolds.instOrderId → instOrders.id
 *
 * =====================================================
 */



// ----------------------------------------------------
// 1) Orders → OrderDetails
// ----------------------------------------------------
InstOrders.hasMany(InstOrderDetails, {
    foreignKey: "instOrderId",
    as: "details"
});

InstOrderDetails.belongsTo(InstOrders, {
    foreignKey: "instOrderId",
    as: "order"
});


// ----------------------------------------------------
// 2) Orders → OrderItems
// ----------------------------------------------------
InstOrders.hasMany(InstOrderItems, {
    foreignKey: "instOrderId",
    as: "items"
});

InstOrderItems.belongsTo(InstOrders, {
    foreignKey: "instOrderId",
    as: "order"
});


// ----------------------------------------------------
// 3) OrderItems → OrderSteps
// ----------------------------------------------------
InstOrderItems.hasMany(InstOrderSteps, {
    foreignKey: "instOrderItemId",
    as: "steps"
});

InstOrderSteps.belongsTo(InstOrderItems, {
    foreignKey: "instOrderItemId",
    as: "item"
});


// ----------------------------------------------------
// 4) OrderSteps → Master Steps (instSteps)
// ----------------------------------------------------
InstSteps.hasMany(InstOrderSteps, {
    foreignKey: "instStepId",
    as: "orderSteps"
});

InstOrderSteps.belongsTo(InstSteps, {
    foreignKey: "instStepId",
    as: "stepInfo"
});


// ----------------------------------------------------
// 5) OrderSteps → StepUpdates
// ----------------------------------------------------
InstOrderSteps.hasMany(InstOrderStepUpdates, {
    foreignKey: "instOrderStepId",
    as: "updates"
});

InstOrderStepUpdates.belongsTo(InstOrderSteps, {
    foreignKey: "instOrderStepId",
    as: "orderStep"
});


// ----------------------------------------------------
// 6) Users → StepUpdates
// ----------------------------------------------------
User.hasMany(InstOrderStepUpdates, {
    foreignKey: "user_id",
    as: "stepUpdates"
});

InstOrderStepUpdates.belongsTo(User, {
    foreignKey: "user_id",
    as: "user"
});


// ----------------------------------------------------
// 7) Team Checkpoints
// ----------------------------------------------------
InstTeamCheckpoints.belongsTo(User, {
    foreignKey: "user_id",
    as: "user"
});

InstTeamCheckpoints.belongsTo(InstTeams, {
    foreignKey: "team_id",
    as: "team"
});

InstTeamCheckpoints.belongsTo(InstOrders, {
    foreignKey: "order_id",
    as: "order"
});

InstTeams.hasMany(InstTeamCheckpoints, {
    foreignKey: "team_id",
    as: "checkpoints"
});


// ----------------------------------------------------
// 8) Order Holds
// ----------------------------------------------------
InstOrderHolds.belongsTo(InstOrders, {
    foreignKey: "instOrderId",
    as: "order"
});

InstOrders.hasMany(InstOrderHolds, {
    foreignKey: "instOrderId",
    as: "holds"
});
