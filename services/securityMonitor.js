// backend/services/securityMonitor.js
// Proactive credential-spray detector -- the real brute-force signature is
// one IP failing logins against SEVERAL DIFFERENT usernames in a short
// window, not one account being repeatedly mistyped from its own device
// (confirmed against this app's live LoginAudit data on 2026-09-15: every
// admin failure traced to the same office IP immediately followed by a
// success, and the busiest IP in the whole 24h window was one employee's
// own phone retrying its own account -- neither is an attack). Runs
// periodically rather than on every single failed login, since the signal
// only exists once several attempts have accumulated.
//
// Private/LAN IPs (192.168.*, 10.*, 172.16-31.*, 127.*) are excluded from
// detection -- a shared office workstation or kiosk genuinely produces
// several different employees' failed logins from one IP, which is normal
// there and would otherwise be a constant false positive.
import { Op, fn, col, literal } from 'sequelize';
import { LoginAudit } from '../models/LoginAudit.js';
import { SecurityAlert } from '../models/SecurityAlert.js';
import { User } from '../models/User.js';
import { sendPushToUser } from './pushNotifications.js';

const WINDOW_MINUTES = 15;
const DISTINCT_USERNAME_THRESHOLD = 4;
// Don't re-alert on the same IP while an ongoing spree is still being
// reviewed -- one alert per IP per cooldown window, not one per check tick.
const ALERT_COOLDOWN_MINUTES = 60;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
// Cap how many usernames get stored on the alert row itself -- enough to
// see the shape of the attempt at a glance; the full list is still
// available via /suspicious-activity/ip/:ip/usernames.
const USERNAMES_SAMPLE_LIMIT = 20;

const PRIVATE_IP_REGEX = /^(192\.168\.|10\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/;

export async function checkForCredentialSprayAttacks() {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

    const offenders = await LoginAudit.findAll({
        where: { success: false, createdAt: { [Op.gte]: since }, ip: { [Op.ne]: null } },
        attributes: [
            'ip',
            [fn('COUNT', col('id')), 'failCount'],
            [fn('COUNT', fn('DISTINCT', col('username'))), 'distinctUsernames'],
        ],
        group: ['ip'],
        having: literal(`COUNT(DISTINCT username) >= ${DISTINCT_USERNAME_THRESHOLD}`),
        raw: true,
    });

    for (const offender of offenders) {
        const ip = offender.ip;
        if (PRIVATE_IP_REGEX.test(ip)) continue;

        const cooldownSince = new Date(Date.now() - ALERT_COOLDOWN_MINUTES * 60 * 1000);
        const recentAlert = await SecurityAlert.findOne({
            where: { type: 'credential_spray', ip, createdAt: { [Op.gte]: cooldownSince } },
        });
        if (recentAlert) continue;

        const usernameRows = await LoginAudit.findAll({
            where: { success: false, ip, createdAt: { [Op.gte]: since } },
            attributes: ['username'],
            group: ['username'],
            limit: USERNAMES_SAMPLE_LIMIT,
            raw: true,
        });
        const usernames = usernameRows.map((r) => r.username);

        const alert = await SecurityAlert.create({
            type: 'credential_spray',
            ip,
            distinctUsernames: Number(offender.distinctUsernames),
            failCount: Number(offender.failCount),
            windowMinutes: WINDOW_MINUTES,
            usernames: JSON.stringify(usernames),
        });

        console.warn(`🚨 SECURITY ALERT: credential spray from ${ip} -- ${offender.distinctUsernames} distinct usernames, ${offender.failCount} failed attempts in the last ${WINDOW_MINUTES}min. Usernames tried: ${usernames.join(', ')}`);

        try {
            const admins = await User.findAll({ where: { role: 'admin', active: true } });
            await Promise.all(admins.map((admin) => sendPushToUser(admin.userId, {
                title: 'Suspicious login activity',
                body: `${ip} failed login for ${offender.distinctUsernames} different accounts in ${WINDOW_MINUTES} min.`,
                data: { type: 'security_alert', alertId: alert.id, ip },
            })));
            await alert.update({ notifiedAdmins: true });
        } catch (err) {
            console.error('❌ Failed to notify admins of security alert:', err);
        }
    }
}

export function startSecurityMonitor() {
    checkForCredentialSprayAttacks().catch((err) => console.error('❌ Security monitor check failed:', err));
    setInterval(() => {
        checkForCredentialSprayAttacks().catch((err) => console.error('❌ Security monitor check failed:', err));
    }, CHECK_INTERVAL_MS).unref();
}
