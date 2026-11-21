// ------------------------------------------------------
// backend/scripts/create-network-tables.js
// ------------------------------------------------------
// Creates NetworkSnapshots + NetworkMonitorTargets + NetworkDeviceNotes
// (models/Network.js) for the IT network page. New, empty tables only --
// the models' own .sync() (create-if-missing, non-destructive), same as
// create-it-licenses-tables.js. Safe to re-run.
//
// `--seed-targets` also adds the core infrastructure hosts to the ping
// monitor, but only when the targets table is still empty.
import { NetworkSnapshot, NetworkMonitorTarget, NetworkDeviceNote } from "../models/Network.js";

const CORE_TARGETS = [
    { name: "Internet (Cloudflare DNS)", host: "1.1.1.1", kind: "internet", site: "HQ" },
    { name: "Meraki MX gateway", host: "192.168.20.50", kind: "network", site: "HQ" },
    { name: "PETRA-DC3", host: "192.168.20.1", kind: "dc", site: "HQ" },
    { name: "PETRA-DC2", host: "192.168.20.6", kind: "dc", site: "HQ" },
    { name: "Hyper-V host PETRA-HYPERV01", host: "192.168.20.93", kind: "server", site: "HQ" },
    { name: "PETRA-APP", host: "192.168.20.88", kind: "server", site: "HQ" },
    { name: "PETRA-FILES", host: "192.168.20.129", kind: "server", site: "HQ" },
    { name: "PETRA-ARCHIVE", host: "192.168.20.111", kind: "server", site: "HQ" },
    { name: "PETRAWEB", host: "192.168.20.18", kind: "server", site: "HQ" },
    { name: "Synology Archive-Petra", host: "192.168.20.14", kind: "nas", site: "HQ" },
    { name: "Synology File-Storage", host: "192.168.20.15", kind: "nas", site: "HQ" },
    { name: "Synology petra-filesrv (Veeam)", host: "192.168.20.16", kind: "nas", site: "HQ" },
    { name: "Aruba AP-1", host: "192.168.20.94", kind: "network", site: "HQ" },
    { name: "Aruba AP-2", host: "192.168.20.95", kind: "network", site: "HQ" },
];

const run = async () => {
    try {
        await NetworkSnapshot.sync();
        await NetworkMonitorTarget.sync();
        await NetworkDeviceNote.sync();
        console.log("✅ NetworkSnapshots + NetworkMonitorTargets + NetworkDeviceNotes ready");
        if (process.argv.includes("--seed-targets")) {
            const count = await NetworkMonitorTarget.count();
            if (count > 0) {
                console.log(`ℹ️  ${count} monitor target(s) already exist -- not seeding`);
            } else {
                await NetworkMonitorTarget.bulkCreate(CORE_TARGETS);
                console.log(`✅ Seeded ${CORE_TARGETS.length} monitor targets`);
            }
        }
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create network tables:", err);
        process.exit(1);
    }
};

run();
