// backend/services/mailer.js
// Minimal internal email sender (first use: security alerts, so they reach
// admins even when nobody has the mobile app's push token registered).
// Sends through the company Exchange server's SMTP relay, like the legacy
// PHP pages on SYS-DOC do. Off unless SMTP_HOST is set in .env:
//   SMTP_HOST=Petra-Exchange   SMTP_PORT=25   SMTP_FROM=petra-app@petralu.com
//   SECURITY_ALERT_EMAILS=itservices@petralu.com,another@petralu.com
// Optional: SMTP_USER / SMTP_PASS (if the relay needs auth),
// SMTP_TLS_INSECURE=true (internal relay whose certificate Node doesn't
// trust -- the domain CA lives in the Windows store, not Node's).
import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
    if (!process.env.SMTP_HOST) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT, 10) || 25,
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
            tls: process.env.SMTP_TLS_INSECURE === 'true' ? { rejectUnauthorized: false } : undefined,
            connectionTimeout: 10000,
            greetingTimeout: 10000,
        });
    }
    return transporter;
}

export function emailList(envValue) {
    return String(envValue || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /.+@.+/.test(s));
}

// Best-effort: returns false (and logs) instead of throwing.
export async function sendMail({ to, subject, text, html }) {
    const t = getTransporter();
    const recipients = Array.isArray(to) ? to : emailList(to);
    if (!t || !recipients.length) return false;
    try {
        await t.sendMail({ from: process.env.SMTP_FROM || 'petra-app@petralu.com', to: recipients, subject, text, html });
        return true;
    } catch (err) {
        console.error('❌ Email send failed:', err.message);
        return false;
    }
}
