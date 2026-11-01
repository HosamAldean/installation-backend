// backend/models/ItLicense.js
// IT section's renewable licenses/subscriptions (domains, SSL, software,
// cloud, antivirus...) -- admin-only tracker with expiry reminders pushed
// to admins by services/itLicenseMonitor.js. Added 2026-11-01.
//
// No secrets here on purpose: accountRef says where the license is
// managed (e.g. "Directnic -- account itservices@"), never a password or
// license key.
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const IT_LICENSE_CATEGORIES = [
    'domain', 'ssl', 'software', 'cloud', 'hosting', 'email', 'antivirus', 'support', 'other',
];

export const ItLicense = sequelize2.define('ItLicense', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    productName: { type: DataTypes.STRING(200), allowNull: false },
    category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other' },
    vendor: { type: DataTypes.STRING(150), allowNull: true },
    accountRef: { type: DataTypes.STRING(255), allowNull: true },
    seats: { type: DataTypes.INTEGER, allowNull: true },
    purchaseDate: { type: DataTypes.DATEONLY, allowNull: true },
    expiryDate: { type: DataTypes.DATEONLY, allowNull: false },
    autoRenew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    cost: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: true },
    // First reminder this many days before expiry; after that the monitor
    // also reminds at 14/7/3/1 days and on the day itself.
    remindDaysBefore: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    status: { type: DataTypes.ENUM('active', 'cancelled'), allowNull: false, defaultValue: 'active' },
    // Renewal follow-up: who/what is in progress before it's actually renewed.
    followUpStatus: {
        type: DataTypes.ENUM('none', 'in_progress', 'waiting_payment'),
        allowNull: false,
        defaultValue: 'none',
    },
    followUpNote: { type: DataTypes.STRING(500), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    // Reminder bookkeeping (services/itLicenseMonitor.js): the last
    // threshold pushed for the current expiryDate -- reset whenever the
    // expiry date changes so a renewed license starts fresh.
    lastReminderDays: { type: DataTypes.INTEGER, allowNull: true },
    lastReminderAt: { type: DataTypes.DATE, allowNull: true },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'ItLicenses',
    timestamps: true,
});
