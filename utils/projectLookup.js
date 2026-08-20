// backend/utils/projectLookup.js
// The transport request form's "Project # / Name" field (projectLabel) is
// free text -- an employee often just types the project number and skips
// the name. When it's purely numeric, look it up against Petra ERP's
// project.projectNo (IIT_Petra schema) and append the real projectName so
// approval/report screens aren't left showing a bare number. Anything
// already containing a name (or not matching a known project) is left
// exactly as typed.
import { Op } from "sequelize";
import { Project } from "../models/Project.js";

// The mobile keyboard's Arabic layout types Arabic-Indic digits (٠-٩) by
// default, not ASCII 0-9 -- an employee typing just a project number often
// ends up with e.g. "٤٨٨٦" instead of "4886". Project.projectNo is stored
// as plain ASCII, so without normalizing first, both the "is this purely
// numeric" check and the DB lookup silently missed every Arabic-Indic
// label, leaving the approval card showing a bare number with no project
// name ever appended. Covers both Arabic-Indic (U+0660-0669, used here)
// and Eastern Arabic-Indic (U+06F0-06F9, Persian/Urdu keyboards) for the
// same reason.
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function toAsciiDigits(str) {
    return String(str).replace(/[٠-٩۰-۹]/g, (d) => {
        const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(d);
        if (arabicIndex !== -1) return String(arabicIndex);
        return String(EASTERN_ARABIC_INDIC_DIGITS.indexOf(d));
    });
}

export async function resolveProjectLabels(rawLabels) {
    const numericLabels = [...new Set(
        rawLabels
            .filter((l) => l && /^[\d٠-٩۰-۹]+$/.test(String(l).trim()))
            .map((l) => toAsciiDigits(String(l).trim())),
    )];
    if (numericLabels.length === 0) return {};
    const projects = await Project.findAll({
        where: { projectNo: { [Op.in]: numericLabels } },
        attributes: ["projectNo", "projectName"],
    });
    return Object.fromEntries(projects.map((p) => [p.projectNo, p.projectName]));
}

// Applies the lookup to a single transport row's projectLabel, returning
// the display string (unchanged if not purely numeric or no match found).
// Keeps the original (possibly Arabic-Indic) digits in the displayed
// prefix -- only the lookup key is normalized -- so the card still shows
// exactly what the employee typed.
export function withProjectDisplay(projectLabel, projectNames) {
    if (!projectLabel) return projectLabel;
    const trimmed = String(projectLabel).trim();
    const name = projectNames[toAsciiDigits(trimmed)];
    return name ? `${trimmed} - ${name}` : projectLabel;
}
