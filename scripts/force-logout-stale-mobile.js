// ------------------------------------------------------
// backend/scripts/force-logout-stale-mobile.js
// ------------------------------------------------------
// One-off: force-logs-out every currently-online account whose last-known
// mobile app build is behind MIN_SUPPORTED_VERSION_CODE, so they hit the
// mandatory update block immediately instead of waiting for their token to
// expire naturally. Run manually after cutting a release + sending the
// update broadcast (notify-all-users-update.js).
//
// Bumps sessionVersion directly in the DB (same mechanism as a normal
// login's single-active-session enforcement / the admin force-logout
// endpoint) -- safe to do from a standalone script rather than the live
// endpoint because middleware/auth.js's in-memory session cache has only a
// 30s TTL, so the running server picks up this DB change on its own well
// within that window; no need to reach into its process directly.
//
// Deliberately scoped to mobile users only (lastMobileAppVersionCode set
// AND below the minimum) -- web sessions never report an app version and
// have nothing to do with a mobile release, so they're left alone.
import { User } from "../models/User.js";
import { MIN_SUPPORTED_VERSION_CODE } from "../constants/mobileAppVersion.js";
import { Op } from "sequelize";

const run = async () => {
    try {
        const staleUsers = await User.findAll({
            where: {
                isOnline: true,
                lastMobileAppVersionCode: { [Op.lt]: MIN_SUPPORTED_VERSION_CODE },
            },
            attributes: ["userId", "username", "sessionVersion", "lastMobileAppVersionCode"],
        });

        console.log(`Found ${staleUsers.length} online user(s) on a build below ${MIN_SUPPORTED_VERSION_CODE}.`);
        for (const u of staleUsers) {
            await u.update({ isOnline: false, sessionVersion: u.sessionVersion + 1 });
            console.log(`  ✅ Force-logged-out ${u.username} (build ${u.lastMobileAppVersionCode})`);
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to force-logout stale mobile users:", err);
        process.exit(1);
    }
};

run();
