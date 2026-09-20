import { sequelizeUtf8 } from './config/db.js';
import { resolveEmployeeNames } from './utils/employeeLookup.js';
import { resolveUserNames } from './utils/userLookup.js';

const [rows] = await sequelizeUtf8.query(`SELECT * FROM HrLeaveRequests WHERE id = 51`);
const r = rows[0];
const empNames = await resolveEmployeeNames([r.managerApproverEmpNo]);
const userNames = await resolveUserNames([r.hrReviewerUserId]);
console.log(JSON.stringify({ row: r, empNames, userNames }, null, 2));
process.exit(0);
