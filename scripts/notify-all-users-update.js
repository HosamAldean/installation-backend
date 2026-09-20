// backend/scripts/notify-all-users-update.js
// One-off broadcast: tells every device with a registered push token that a
// new mobile build is available. Unlike the in-app update-check (HomeScreen),
// this reaches devices running a build old enough to have NO update-checking
// code at all -- an OS-level FCM notification with a `notification` payload
// is rendered by Android itself, not by app code, so even the very first
// installed build (before any of this feature existed) will show it.
// Run manually after cutting a release: `node scripts/notify-all-users-update.js`.
import { User } from "../models/User.js";
import { LATEST_VERSION_NAME, UPDATE_PAGE_URL } from "../constants/mobileAppVersion.js";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccount = JSON.parse(
    readFileSync(path.join(__dirname, "../config/firebase-service-account.json"), "utf-8")
);
const firebaseApp = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });

const run = async () => {
    try {
        const users = await User.findAll({
            where: { active: true },
            attributes: ["userId", "username", "pushToken"],
        });
        const tokens = users.filter((u) => u.pushToken).map((u) => u.pushToken);
        console.log(`Found ${tokens.length} device(s) with a registered push token (of ${users.length} active users).`);
        if (!tokens.length) {
            process.exit(0);
        }

        const result = await getMessaging(firebaseApp).sendEachForMulticast({
            tokens,
            notification: {
                title: "Update available / تحديث متوفر",
                body: `Petra Mobile v${LATEST_VERSION_NAME} is available -- open this link to update: ${UPDATE_PAGE_URL}\n\nيتوفر إصدار جديد من تطبيق بترا موبايل. افتح هذا الرابط للتحديث: ${UPDATE_PAGE_URL}`,
            },
            data: { type: "update_required", downloadUrl: UPDATE_PAGE_URL },
            android: { priority: "high" },
        });
        console.log(`✅ Sent: ${result.successCount} succeeded, ${result.failureCount} failed.`);
        result.responses.forEach((r, i) => {
            if (!r.success) console.error(`  ❌ token ${tokens[i].slice(0, 12)}...: ${r.error?.message}`);
        });
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to send update broadcast:", err);
        process.exit(1);
    }
};

run();
