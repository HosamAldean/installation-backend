// backend/services/softwareDeploy.js
// Software Library phase 2 (2026-11-26): install a library item on PCs.
//
// Pull model, no new agent: Send-PcReport.ps1 already runs on every PC as
// SYSTEM (GPO, startup + every 4 h). The /report reply hands the PC its
// pending jobs; the PC copies the installer from the software share, checks
// the SHA-256, runs it silently and posts the result to /report/job.
//
// Safety, in layers:
//   - only library items whose installer is on the share, seen by the
//     scanner, with a SHA-256 that matches the file there, can be queued;
//   - path, hash and arguments are frozen into the job when it is queued;
//   - the PC script itself refuses any path outside \\PETRA-FILES\Software$\
//     and any file whose SHA-256 differs from the job (checked on its own
//     local copy, right before running it);
//   - only .msi / .msp / .exe (an .exe needs silent arguments);
//   - queuing needs it.software.deploy, separate from it.software.
import { Op } from "sequelize";
import { SoftwareDeployJob } from "../models/SoftwareDeployJob.js";

export const SHARE_ROOT = "\\\\PETRA-FILES\\Software$\\";
export const DEPLOY_EXTENSIONS = [".msi", ".msp", ".exe"];
// A job handed to a PC with no result after this long is marked failed
// (PC switched off mid-install, script killed, ...).
const SENT_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const JOBS_PER_REPORT = 3;
// msiexec / most installers: 0 = OK, 3010 / 1641 = OK, restart needed.
export const OK_EXIT_CODES = [0, 3010, 1641];

const ext = (p) => (/\.[^.\\]+$/.exec(String(p ?? "")) ?? [""])[0].toLowerCase();

// Why a library item cannot be installed from the app (null = it can).
export function deployBlocker(item, share) {
    if (!item) return "Not found";
    if (item.status === "retired") return "Item is retired";
    if (!item.installerPath) return "No installer file";
    if (!item.installerPath.toLowerCase().startsWith(SHARE_ROOT.toLowerCase())) return "Installer is not on the software share";
    if (!DEPLOY_EXTENSIONS.includes(ext(item.installerPath))) return "Only .msi, .msp and .exe installers can be installed from the app";
    if (!item.sha256) return "No SHA-256 on the item";
    const f = (share?.files ?? []).find((x) => String(x.path).toLowerCase() === item.installerPath.toLowerCase());
    if (!f) return "Installer file not found on the share";
    if (f.sha256 !== item.sha256) return "Installer file changed (SHA-256 differs)";
    if (ext(item.installerPath) === ".exe" && !item.installArgs) return "An .exe needs silent install arguments";
    return null;
}

async function expireStale(where = {}) {
    await SoftwareDeployJob.update(
        { status: "failed", finishedAt: new Date(), message: "No result from the PC (switched off or install stopped)" },
        { where: { ...where, status: "sent", sentAt: { [Op.lt]: new Date(Date.now() - SENT_TIMEOUT_MS) } } },
    );
}

// Called from /report: the PC's pending jobs, marked sent.
export async function takeJobsForPc(computerName) {
    const name = String(computerName).toUpperCase();
    await expireStale({ computerName: name });
    const jobs = await SoftwareDeployJob.findAll({
        where: { computerName: name, status: "pending" },
        order: [["id", "ASC"]],
        limit: JOBS_PER_REPORT,
    });
    if (!jobs.length) return [];
    await SoftwareDeployJob.update(
        { status: "sent", sentAt: new Date() },
        { where: { id: jobs.map((j) => j.id), status: "pending" } },
    );
    return jobs.map((j) => ({
        id: j.id,
        name: j.itemName,
        path: j.installerPath,
        sha256: j.sha256,
        args: j.installArgs ?? "",
    }));
}

// Called from /report/job: the PC's result for a job it was sent.
export async function recordJobResult(computerName, body) {
    const id = Number.parseInt(body?.id, 10);
    if (!id) return { error: "Bad id" };
    const job = await SoftwareDeployJob.findByPk(id);
    if (!job || job.computerName !== String(computerName).toUpperCase()) return { error: "Not found" };
    if (job.status !== "sent") return { error: "Job is not waiting for a result" };
    const exitCode = Number.isFinite(Number(body?.exitCode)) ? Math.trunc(Number(body.exitCode)) : null;
    const ok = body?.ok === true && exitCode !== null && OK_EXIT_CODES.includes(exitCode);
    let message = String(body?.message ?? "").trim().slice(0, 900) || null;
    if (ok && exitCode !== 0) message = [message, "Restart needed to finish"].filter(Boolean).join(" -- ");
    await job.update({ status: ok ? "success" : "failed", exitCode, message, finishedAt: new Date() });
    return { job };
}

export async function listJobs({ itemId, computerName, limit = 200 } = {}) {
    await expireStale();
    const where = {};
    if (itemId) where.itemId = itemId;
    if (computerName) where.computerName = String(computerName).toUpperCase();
    return SoftwareDeployJob.findAll({ where, order: [["id", "DESC"]], limit, raw: true });
}
