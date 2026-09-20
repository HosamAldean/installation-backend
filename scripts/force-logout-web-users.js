// ------------------------------------------------------
// backend/scripts/force-logout-web-users.js
// ------------------------------------------------------
// One-off: force-logs-out every currently-online account whose active
// session came from the web app (as opposed to mobile) -- mirrors force-
// logout-stale-mobile.js's mechanism (bump sessionVersion directly in the
// DB; the running server's session cache has only a 30s TTL, see that
// script's own comment for why a direct DB write is safe here).
//
// There's no live "which platform is this session on" flag stored per
// user -- only LoginAudits' per-login-attempt platform field (routes/
// auth.js's /login, 'mobile' iff appVersionCode was sent). Under this
// app's single-active-session enforcement (one valid sessionVersion per
// account at a time), each online user's most recent *successful* login
// is exactly their current session, so that row's platform reliably
// identifies it.
import { User } from "../models/User.js";
import { LoginAudit } from "../models/LoginAudit.js";

const run = async () => {
    try {
        const onlineUsers = await User.findAll({
            where: { isOnline: true },
            attributes: ["userId", "username", "sessionVersion"],
        });

        const webUsers = [];
        for (const u of onlineUsers) {
            const lastLogin = await LoginAudit.findOne({
                where: { userId: u.userId, success: true },
                order: [["createdAt", "DESC"]],
            });
            // No LoginAudit row at all means this session predates the
            // audit table (logged in before this feature existed) -- can't
            // confirm it's web, but it can't be confirmed mobile either, so
            // treat unknown as web (the safer default: this app's day-to-
            // day usage is overwhelmingly web, and worst case a mobile user
            // just has to log back in, same as everyone else here).
            if (!lastLogin || lastLogin.platform === "web") {
                webUsers.push(u);
            }
        }

        console.log(`Found ${webUsers.length} currently-online web session(s) (of ${onlineUsers.length} online total).`);
        for (const u of webUsers) {
            await u.update({ isOnline: false, sessionVersion: u.sessionVersion + 1 });
            console.log(`  ✅ Force-logged-out ${u.username}`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to force-logout web users:", err);
        process.exit(1);
    }
};

run();
