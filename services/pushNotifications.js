// Sends push notifications via Firebase Cloud Messaging using the raw FCM
// device token the mobile app registers (see mobile/tasks/pushNotificationTask.ts)
// — not Expo's push relay service, so this calls FCM directly.
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { User } from "../models/User.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccount = JSON.parse(
    readFileSync(path.join(__dirname, "../config/firebase-service-account.json"), "utf-8")
);

const firebaseApp = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });

// Best-effort — a failed/missing push token should never break the calling
// request (e.g. an HR decision must still save even if the employee's
// device is offline or has never registered for push).
export async function sendPushToUser(userId, { title, body, data } = {}) {
    try {
        const user = await User.findByPk(userId);
        if (!user?.pushToken) return;

        await getMessaging(firebaseApp).send({
            token: user.pushToken,
            notification: { title, body },
            data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
            android: { priority: "high" },
        });
    } catch (err) {
        console.error(`❌ Push notification failed for userId ${userId}:`, err.message);
    }
}
