// backend/services/itLicenseMonitor.js
// Expiry reminders for the IT licenses tracker (models/ItLicense.js).
// Checks hourly; each active license is pushed to every active admin once
// per threshold -- its own remindDaysBefore, then 14/7/3/1 days and the
// expiry day -- and weekly after it has expired until it's renewed or
// cancelled. lastReminderDays on the row makes this idempotent across
// restarts; editing/renewing the expiry date resets it.
import { ItLicense } from '../models/ItLicense.js';
import { User } from '../models/User.js';
import { sendPushToUser } from './pushNotifications.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIXED_THRESHOLDS = [14, 7, 3, 1, 0];
const EXPIRED_REPEAT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function ammanToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Amman' });
}

// Whole days from today (Amman) to the expiry date; negative = expired.
export function daysUntil(expiryDate, today = ammanToday()) {
    return Math.round((Date.parse(expiryDate) - Date.parse(today)) / DAY_MS);
}

// The threshold a license is currently inside, or null if it's not due yet.
export function reminderThreshold(daysLeft, remindDaysBefore) {
    const thresholds = [...new Set([remindDaysBefore, ...FIXED_THRESHOLDS])]
        .filter((t) => t <= remindDaysBefore)
        .sort((a, b) => a - b);
    return thresholds.find((t) => daysLeft <= t) ?? null;
}

function reminderText(license, daysLeft) {
    const what = `${license.productName}${license.vendor ? ` (${license.vendor})` : ''}`;
    if (daysLeft < 0) return `${what} expired ${-daysLeft} day(s) ago (${license.expiryDate}).`;
    if (daysLeft === 0) return `${what} expires today (${license.expiryDate}).`;
    return `${what} expires in ${daysLeft} day(s), on ${license.expiryDate}.`;
}

export async function checkItLicenseReminders() {
    const today = ammanToday();
    const licenses = await ItLicense.findAll({ where: { status: 'active' } });
    const due = [];
    for (const license of licenses) {
        const daysLeft = daysUntil(license.expiryDate, today);
        if (daysLeft < 0) {
            const last = license.lastReminderAt ? new Date(license.lastReminderAt).getTime() : 0;
            if (license.lastReminderDays !== null && license.lastReminderDays < 0
                && Date.now() - last < EXPIRED_REPEAT_DAYS * DAY_MS) continue;
            due.push({ license, daysLeft, stage: -1 });
            continue;
        }
        const stage = reminderThreshold(daysLeft, license.remindDaysBefore);
        if (stage === null) continue;
        if (license.lastReminderDays !== null && license.lastReminderDays <= stage) continue;
        due.push({ license, daysLeft, stage });
    }
    if (due.length === 0) return 0;

    const admins = await User.findAll({ where: { role: 'admin', active: true }, attributes: ['userId'] });
    for (const { license, daysLeft, stage } of due) {
        await Promise.all(admins.map((admin) => sendPushToUser(admin.userId, {
            title: daysLeft < 0 ? 'License expired' : 'License renewal due',
            body: reminderText(license, daysLeft),
            data: { type: 'it_license', licenseId: license.id },
        })));
        await license.update({ lastReminderDays: stage, lastReminderAt: new Date() });
    }
    return due.length;
}

export function startItLicenseMonitor() {
    const run = () => checkItLicenseReminders()
        .catch((err) => console.error('❌ IT license reminder check failed:', err));
    run();
    setInterval(run, CHECK_INTERVAL_MS).unref();
}
