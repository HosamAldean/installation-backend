// backend/models/Network.js
// IT network page (routes/network.js, services/networkMonitor.js), added
// 2026-11-21. Three small tables on sequelize2 (IIT_Petra), like the IT
// licenses tracker:
//
// - NetworkSnapshots: the latest raw pull from each source (Meraki clients /
//   devices / uplinks / VPN, and the DHCP + AD inventory pushed by the
//   scheduled script on DC3). One row per source, overwritten each time, so
//   a restart -- or the PC test backend, which runs no background jobs --
//   still has the last known picture. The device list is merged from these
//   at request time.
// - NetworkMonitorTargets: hosts the ping/port monitor checks every minute.
// - NetworkDeviceNotes: what IT types about a device (label, owner, notes),
//   keyed by MAC (or "ad:<NAME>" for AD computers never seen on the wire).
import { DataTypes } from 'sequelize';
import { sequelize2 } from '../config/db.js';

export const NETWORK_SNAPSHOT_SOURCES = [
    'meraki_networks',
    'meraki_devices',
    'meraki_uplinks',
    'meraki_vpn',
    'meraki_clients',
    'dhcp',
    'ad',
];

export const NetworkSnapshot = sequelize2.define('NetworkSnapshot', {
    source: { type: DataTypes.STRING(40), primaryKey: true },
    data: { type: DataTypes.TEXT('long'), allowNull: true },
    fetchedAt: { type: DataTypes.DATE, allowNull: true },
    // Last error from this source (cleared on the next good pull) -- the
    // page shows it next to the source's age.
    error: { type: DataTypes.STRING(500), allowNull: true },
    errorAt: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'NetworkSnapshots',
    timestamps: false,
});

export const NETWORK_TARGET_KINDS = [
    'server', 'dc', 'nas', 'network', 'printer', 'camera', 'pc', 'internet', 'other',
];

export const NetworkMonitorTarget = sequelize2.define('NetworkMonitorTarget', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    host: { type: DataTypes.STRING(255), allowNull: false },
    // null = ICMP ping; a number = TCP connect to that port instead (for
    // hosts whose firewall drops ping, or to check the service itself).
    port: { type: DataTypes.INTEGER, allowNull: true },
    kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'other' },
    site: { type: DataTypes.STRING(50), allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Push a "down" / "back up" notification to it.network holders.
    notify: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    // Monitor bookkeeping.
    status: { type: DataTypes.ENUM('unknown', 'up', 'down'), allowNull: false, defaultValue: 'unknown' },
    lastRttMs: { type: DataTypes.INTEGER, allowNull: true },
    lastCheckedAt: { type: DataTypes.DATE, allowNull: true },
    lastChangeAt: { type: DataTypes.DATE, allowNull: true },
    consecutiveFails: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.STRING(255), allowNull: true },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'NetworkMonitorTargets',
    timestamps: true,
});

export const NetworkDeviceNote = sequelize2.define('NetworkDeviceNote', {
    deviceKey: { type: DataTypes.STRING(80), primaryKey: true },
    label: { type: DataTypes.STRING(100), allowNull: true },
    owner: { type: DataTypes.STRING(100), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true },
}, {
    tableName: 'NetworkDeviceNotes',
    timestamps: true,
});
