// ------------------------------------------------------
// backend/scripts/create-hr-tables.js
// ------------------------------------------------------
// Creates the 5 tables backing the new "Employee Gate" HR self-service
// forms (leave/departure, attendance correction, work-departure +
// transportation allowance — digitized versions of paper forms HR 10-20,
// HR 10-26, HR 10-34). All 5 live on the sequelizeUtf8 MySQL connection,
// same as FollowUpNotes -- genuinely new tables with no legacy Access/ERP
// equivalent, so there's nothing to port or backfill.
//
// Deliberately NOT on PayEmp/Pay_Job (the ERP SQL Server database) or any
// existing table: this is a first, standalone pilot phase per explicit
// direction -- approval routing reads PayEmp.Supervisor_No live (never
// writes to it), and leave balances read PayEmp.Vac_Bal live (also never
// written). A tighter ERP integration is an intentional future step, not
// this one.
//
// Uses each model's own .sync() (create-if-missing, non-destructive) since
// these are Sequelize models, unlike create-item-profile-table.js's raw
// SQL Server CREATE TABLE. Safe to re-run.
import {
    HrLeaveRequest,
    HrAttendanceCorrectionRequest,
    HrAttendanceCorrectionRow,
    HrTransportRequest,
    HrTransportAccompanier,
} from "../models/index.js";

const run = async () => {
    try {
        await HrLeaveRequest.sync();
        console.log("✅ HrLeaveRequests ready");
        await HrAttendanceCorrectionRequest.sync();
        console.log("✅ HrAttendanceCorrectionRequests ready");
        await HrAttendanceCorrectionRow.sync();
        console.log("✅ HrAttendanceCorrectionRows ready");
        await HrTransportRequest.sync();
        console.log("✅ HrTransportRequests ready");
        await HrTransportAccompanier.sync();
        console.log("✅ HrTransportAccompaniers ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create HR tables:", err);
        process.exit(1);
    }
};

run();
