// backend/utils/userLookup.js
// Batch-resolve InsUser.userId -> display name -- HrLeaveRequest/
// HrAttendanceCorrectionRequest/HrTransportRequest store the reviewing
// HR/Finance user's InsUser.userId (not an ERP empNo, unlike the
// requester/manager fields -- see utils/employeeLookup.js for those), since
// HR/Finance staff are login accounts, not necessarily linked to a payroll
// record via assignedEmpNo.
import { User } from "../models/User.js";

export async function resolveUserNames(userIds) {
    const uniqueUserIds = [...new Set(userIds)].filter((n) => Number.isInteger(n));
    if (uniqueUserIds.length === 0) return {};

    const users = await User.findAll({
        where: { userId: uniqueUserIds },
        attributes: ["userId", "username", "firstName", "lastName"],
    });

    const byUserId = {};
    for (const u of users) {
        const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ");
        byUserId[u.userId] = { userId: u.userId, name: fullName || u.username, username: u.username };
    }
    return byUserId;
}
