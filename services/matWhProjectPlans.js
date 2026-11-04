// backend/services/matWhProjectPlans.js
// Project material plans (2026-11-01) -- see models/MatWhProjectPlan.js.
//
// Cycle v2 (2026-11-04): the projects department reserves material for the
// whole project; production keeps one plan per production ORDER of that
// project (a project has several), fills its lines from an Excel paste or
// the grid and checks them against the project's reservation. A line stays
// "checking" until production requests it, which is allowed only when the
// project's reservation already holds it ready: the request becomes an
// issue request on those reservation lines (split off when it's only part
// of a line), and the store issues only requested lines. Free stock and
// items the project never reserved are shown for information only.
import { Op } from 'sequelize';
import { sequelize2PetraErp, sequelizeUtf8 } from '../config/db.js';
import { MatWhProjectPlan } from '../models/MatWhProjectPlan.js';
import { MatWhProjectPlanItem } from '../models/MatWhProjectPlanItem.js';
import { MatWhReservationHeader } from '../models/MatWhReservationHeader.js';
import { MatWhReservationItem } from '../models/MatWhReservationItem.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemStore } from '../models/MatWhItemStore.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { MatWhStore } from '../models/MatWhStore.js';
import { getAvailableToReserve, normalizeColor } from './matWhLedger.js';
import { filterStores } from './matWhStoreAccess.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Reservation lines holding material that can be issued.
const HOLDING_STATUSES = ['confirmed', 'partially_confirmed'];

const sameColor = (a, b) => (normalizeColor(a || null) || null) === (normalizeColor(b || null) || null);
const sameLength = (a, b) => a == null || b == null || Number(a) === Number(b);

export async function loadPlan(planId) {
    const plan = await MatWhProjectPlan.findByPk(planId);
    if (!plan) throw httpError(404, 'Plan not found');
    return plan;
}

function assertEditable(plan) {
    if (plan.status === 'closed') throw httpError(409, 'This plan is closed');
}

export async function createPlan(values, createdBy) {
    if (!values.projectId) throw httpError(400, 'projectId is required');
    const orderRef = String(values.orderRef || '').trim();
    if (!orderRef) throw httpError(400, 'Order / phase is required');
    return sequelizeUtf8.transaction(async (t) => {
        const placeholder = `TMP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const row = await MatWhProjectPlan.create({
            planNo: placeholder,
            projectId: values.projectId, projectNo: values.projectNo ?? null,
            projectName: values.projectName ?? null, projectManager: values.projectManager ?? null,
            orderRef, plannedStartDate: values.plannedStartDate || null,
            notes: values.notes || null, status: 'draft', createdBy,
        }, { transaction: t });
        await row.update({ planNo: `PLN-${String(row.id).padStart(6, '0')}` }, { transaction: t });
        return row;
    });
}

export async function updatePlan(planId, values) {
    const plan = await loadPlan(planId);
    const patch = {};
    if (values.orderRef !== undefined) {
        const orderRef = String(values.orderRef || '').trim();
        if (!orderRef) throw httpError(400, 'Order / phase is required');
        patch.orderRef = orderRef;
    }
    if (values.plannedStartDate !== undefined) patch.plannedStartDate = values.plannedStartDate || null;
    if (values.notes !== undefined) patch.notes = values.notes || null;
    if (values.status !== undefined) {
        if (!['draft', 'active', 'closed'].includes(values.status)) throw httpError(400, 'Unknown status');
        patch.status = values.status;
    }
    // A closed plan only takes a status change (reopening it).
    if (plan.status === 'closed' && Object.keys(patch).some((k) => k !== 'status')) assertEditable(plan);
    await plan.update(patch);
    return plan;
}

async function alColorKeys() {
    const rows = await sequelize2PetraErp.query(
        `SELECT ci.mixCode, ci.code FROM colorInfo ci
         JOIN colorType ct ON ct.colorTypeId = ci.colorTypeId
         WHERE ct.colorTypeName = 'AL'`,
        { type: sequelize2PetraErp.QueryTypes.SELECT },
    );
    const keys = new Set();
    for (const c of rows) {
        if (c.mixCode) keys.add(c.mixCode.trim().toUpperCase());
        if (c.code) keys.add(c.code.trim().toUpperCase());
    }
    return keys;
}

// Pasted / typed lines: { itemCode, qty, color, lengthMm, storeId,
// neededByDate, notes }. The code may also be a variant barcode, which
// brings its own colour and length. The store is filled in when the item
// is kept in exactly one store. Returns per-line results like the
// production request grid's bulk add.
export async function addPlanLines(planId, rawLines, allowedStoreIds) {
    const plan = await loadPlan(planId);
    assertEditable(plan);
    if (!Array.isArray(rawLines) || rawLines.length === 0) throw httpError(400, 'lines must be a non-empty array');
    const colorKeys = await alColorKeys();
    const results = [];
    for (const raw of rawLines) {
        const code = String(raw?.itemCode || '').trim();
        if (!code) continue;
        const qty = Number(raw?.qty ?? raw?.qtyPlanned);
        if (!Number.isFinite(qty) || qty <= 0) {
            results.push({ itemCode: code, success: false, error: 'Invalid quantity' });
            continue;
        }
        let item = await MatWhItem.findOne({ where: { itemCode: code } });
        let color = String(raw?.color || '').trim() || null;
        let lengthMm = raw?.lengthMm ? Number(raw.lengthMm) || null : null;
        if (!item) {
            const variant = await MatWhItemVariant.findOne({ where: { barcode: code } });
            if (variant) {
                item = await MatWhItem.findByPk(variant.itemId);
                color = color || variant.color || null;
                lengthMm = lengthMm || (variant.lengthMm ? Number(variant.lengthMm) : null);
            }
        }
        if (!item) {
            results.push({ itemCode: code, success: false, error: 'Item not found' });
            continue;
        }
        let warning;
        if (color && color.toUpperCase() !== 'MILL' && !colorKeys.has(color.toUpperCase())) {
            warning = `Unrecognized color "${color}" -- left blank`;
            color = null;
        }
        const knownStoreIds = (await MatWhItemStore.findAll({ where: { itemId: item.id }, attributes: ['storeId'] }))
            .map((s) => s.storeId);
        let storeId = Number(raw?.storeId) || null;
        if (storeId && knownStoreIds.length > 0 && !knownStoreIds.includes(storeId)) {
            results.push({ itemCode: code, success: false, error: 'This item has no record of being in that store' });
            continue;
        }
        if (!storeId && knownStoreIds.length === 1) storeId = knownStoreIds[0];
        if (storeId && allowedStoreIds !== null && !allowedStoreIds.has(storeId)) {
            results.push({ itemCode: code, success: false, error: 'You have no access to that store' });
            continue;
        }
        const line = await MatWhProjectPlanItem.create({
            planId: plan.id, itemId: item.id, storeId,
            color: normalizeColor(color), lengthMm, qtyPlanned: qty,
            neededByDate: raw?.neededByDate || null, notes: raw?.notes ? String(raw.notes).slice(0, 255) : null,
        });
        results.push({
            itemCode: code, success: true, lineId: line.id, itemName: item.itemName,
            warning: warning ?? (storeId ? undefined : 'Pick a store before requesting'),
        });
    }
    return {
        created: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
    };
}

async function loadEditableLine(planId, lineId) {
    const plan = await loadPlan(planId);
    assertEditable(plan);
    const line = await MatWhProjectPlanItem.findOne({ where: { id: lineId, planId: plan.id } });
    if (!line) throw httpError(404, 'Line not found');
    if (line.requestedDate) throw httpError(409, 'This line is already requested from the store');
    return line;
}

export async function updatePlanLine(planId, lineId, values, allowedStoreIds) {
    const line = await loadEditableLine(planId, lineId);
    const patch = {};
    if (values.qtyPlanned !== undefined) {
        const qty = Number(values.qtyPlanned);
        if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'Quantity must be a positive number');
        patch.qtyPlanned = qty;
    }
    if (values.storeId !== undefined) {
        const storeId = Number(values.storeId) || null;
        if (storeId) {
            const known = (await MatWhItemStore.findAll({ where: { itemId: line.itemId }, attributes: ['storeId'] }))
                .map((s) => s.storeId);
            if (known.length > 0 && !known.includes(storeId)) throw httpError(400, 'This item has no record of being in that store');
            if (allowedStoreIds !== null && !allowedStoreIds.has(storeId)) throw httpError(403, 'You have no access to that store');
        }
        patch.storeId = storeId;
    }
    if (values.neededByDate !== undefined) patch.neededByDate = values.neededByDate || null;
    if (values.notes !== undefined) patch.notes = values.notes ? String(values.notes).slice(0, 255) : null;
    // A changed line needs a fresh check.
    patch.checkStatus = null;
    await line.update(patch);
    return line;
}

export async function deletePlanLine(planId, lineId) {
    const line = await loadEditableLine(planId, lineId);
    await line.destroy();
}

// The project's reservation lines for one plan line's item/store/colour/
// length (every reservation of the project counts, whichever request it
// came from). Optionally locked, for the request below.
async function projectReservationLines(plan, line, t = null) {
    const headers = await MatWhReservationHeader.findAll({
        where: { projectId: plan.projectId, status: { [Op.notIn]: ['draft', 'rejected'] } },
        attributes: ['id'], transaction: t,
    });
    if (headers.length === 0) return [];
    const rows = await MatWhReservationItem.findAll({
        where: { reservationHeaderId: headers.map((h) => h.id), itemId: line.itemId, storeId: line.storeId },
        order: [['id', 'ASC']], transaction: t, ...(t ? { lock: t.LOCK.UPDATE } : {}),
    });
    return rows.filter((r) => sameColor(r.color, line.color) && sameLength(r.lengthMm, line.lengthMm));
}

// Reserved for the project, ready, and not yet asked for by any order.
const isFreeReady = (r) => HOLDING_STATUSES.includes(r.status) && Number(r.qtyReserved) > 0
    && !r.issueRequestedDate && r.managerApprovalStatus !== 'pending_manager';

// What the project's reservation holds for one plan line:
//   ready        reserved and free for this order to request
//   coating      reserved lines still at coating
//   purchase     reserved lines still waiting on a purchase order
//   store        lines the store (or the store manager) hasn't decided yet
//   otherOrders  already requested by another order, not issued yet
function summarizeReservation(rows) {
    const out = { ready: 0, coating: 0, purchase: 0, store: 0, otherOrders: 0 };
    for (const r of rows) {
        if (r.status === 'pending') out.store += Number(r.qtyRequested);
        if (!HOLDING_STATUSES.includes(r.status)) continue;
        if (isFreeReady(r)) out.ready += Number(r.qtyReserved);
        if (r.issueRequestedDate) out.otherOrders += Number(r.qtyReserved);
        out.coating += Number(r.qtyPendingCoating || 0);
        if (r.purchaseOrderId) out.purchase += Number(r.qtyShortfall || 0);
    }
    return out;
}

// Re-reads every line not yet requested against the project's reservation
// and saves the snapshot on the line. Never earmarks anything.
//   checkStatus: ready (can be requested) / partial (part of it ready) /
//   coming (the reservation covers it but not all ready yet) /
//   not_reserved (the project hasn't reserved enough) / no_store
//   checkAvailable  ready in the reservation for this order
//   checkAtCoating  reservation still at coating
//   checkIncoming   reservation still on purchase or waiting at the store
//   checkCompeting  requested by the project's other orders, not issued
//   checkMill       free stock in the store, not reserved (information only)
export async function checkPlan(planId) {
    const plan = await loadPlan(planId);
    const lines = await MatWhProjectPlanItem.findAll({ where: { planId: plan.id, requestedDate: null }, order: [['id', 'ASC']] });
    for (const line of lines) {
        if (!line.storeId) {
            await line.update({
                checkStatus: 'no_store', checkAvailable: null, checkMill: null, checkIncoming: null,
                checkAtCoating: null, checkCompeting: null, checkIncomingEta: null,
            });
            continue;
        }
        const res = summarizeReservation(await projectReservationLines(plan, line));
        const color = normalizeColor(line.color);
        const freeStock = await getAvailableToReserve(line.storeId, line.itemId, color ?? undefined, line.lengthMm ?? undefined);
        const need = Number(line.qtyPlanned);
        let status = 'not_reserved';
        if (res.ready >= need) status = 'ready';
        else if (res.ready + res.coating + res.purchase + res.store >= need) status = 'coming';
        else if (res.ready > 0) status = 'partial';
        await line.update({
            checkStatus: status, checkAvailable: res.ready, checkAtCoating: res.coating,
            checkIncoming: res.purchase + res.store, checkCompeting: res.otherOrders,
            checkMill: freeStock, checkIncomingEta: null,
        });
    }
    await plan.update({ lastCheckedAt: new Date() });
    return plan;
}

// Production's issue request (cycle v2): for each chosen line (all lines
// not yet requested when lineIds is null) the project's ready reservation
// must cover the whole quantity -- it's then marked as requested for this
// order, taking whole reservation lines first and splitting the last one
// when only part of it is needed. Goes straight to the store.
export async function requestPlanLines(planId, lineIds, user, allowedStoreIds) {
    const plan = await loadPlan(planId);
    assertEditable(plan);
    const wanted = lineIds ? new Set(lineIds.map(Number)) : null;
    const lines = (await MatWhProjectPlanItem.findAll({ where: { planId: plan.id, requestedDate: null }, order: [['id', 'ASC']] }))
        .filter((l) => !wanted || wanted.has(l.id));
    if (lines.length === 0) throw httpError(400, 'No lines to request -- they are all requested already');
    const items = new Map((await MatWhItem.findAll({ where: { id: [...new Set(lines.map((l) => l.itemId))] } })).map((i) => [i.id, i]));
    const code = (l) => items.get(l.itemId)?.itemCode ?? l.itemId;
    const noStore = lines.filter((l) => !l.storeId);
    if (noStore.length) throw httpError(400, `Pick a store first for: ${noStore.map(code).join(', ')}`);
    if (allowedStoreIds !== null && lines.some((l) => !allowedStoreIds.has(l.storeId))) {
        throw httpError(403, 'Some lines are in a store you have no access to');
    }

    return sequelizeUtf8.transaction(async (t) => {
        const now = new Date();
        let split = 0;
        for (const line of lines) {
            const ready = (await projectReservationLines(plan, line, t)).filter(isFreeReady);
            let remaining = Number(line.qtyPlanned);
            if (ready.reduce((s, r) => s + Number(r.qtyReserved), 0) < remaining) {
                throw httpError(409, `${code(line)}: the project's reservation doesn't hold ${remaining} ready -- check again`);
            }
            const mark = { issueRequestedBy: user.userId, issueRequestedDate: now, issueRequestPlanId: plan.id, issueRequestPlanItemId: line.id };
            for (const r of ready) {
                if (remaining <= 0) break;
                const held = Number(r.qtyReserved);
                const whole = held <= remaining && r.status === 'confirmed'
                    && !(Number(r.qtyPendingCoating) > 0) && !(Number(r.qtyShortfall) > 0);
                if (whole) {
                    await r.update(mark, { transaction: t });
                    remaining -= held;
                    continue;
                }
                // Split the requested part off into its own ready line; the
                // original keeps the rest (and any coating / purchase still
                // owed to it).
                const take = Math.min(held, remaining);
                const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = r.toJSON(); // eslint-disable-line no-unused-vars
                await MatWhReservationItem.create({
                    ...copy, ...mark,
                    qtyRequested: take, qtyReserved: take, qtyPendingCoating: 0, qtyShortfall: 0,
                    status: 'confirmed', purchaseOrderId: null, purchaseOrderItemId: null,
                    substitutesLineId: null, splitFromLineId: r.id,
                }, { transaction: t });
                await r.update({
                    qtyRequested: Number(r.qtyRequested) - take, qtyReserved: held - take,
                }, { transaction: t });
                remaining -= take;
                split += 1;
            }
            await line.update({ requestedBy: user.userId, requestedDate: now }, { transaction: t });
        }
        if (plan.status === 'draft') await plan.update({ status: 'active' }, { transaction: t });
        return { planId: plan.id, lines: lines.length, split };
    });
}

// Where a reservation line has got to, for the project status page.
export function lineStage(header, reqLine) {
    if (!header || !reqLine) return 'not_requested';
    if (header.status === 'draft') return 'draft';
    if (header.status === 'pending_store_mgr') return 'store_manager_approval';
    if (header.status === 'pending_approval') return 'production_approval';
    if (header.status === 'rejected' && (header.productionRejectedBy || header.storeManagerRejectedBy)) return 'rejected';
    switch (reqLine.status) {
        case 'pending': return 'with_store';
        case 'rejected': return 'rejected';
        case 'released': return 'released';
        case 'issued': return 'issued';
        default:
            if (reqLine.managerApprovalStatus === 'pending_manager') return 'manager_approval';
            if (reqLine.issueRequestedDate) return 'issue_requested';
            if (Number(reqLine.qtyPendingCoating) > 0) return 'at_coating';
            if (Number(reqLine.qtyShortfall) > 0) return 'purchasing';
            return 'ready';
    }
}

// Quantities toward the plan: reserved and approved = ready, handed over =
// issued (issued also counts as ready).
function lineProgress(stage, reqLine) {
    if (!reqLine) return { readyQty: 0, issuedQty: 0 };
    const reserved = Number(reqLine.qtyReserved ?? 0);
    if (stage === 'issued') return { readyQty: reserved, issuedQty: reserved };
    if (['ready', 'issue_requested', 'at_coating', 'purchasing'].includes(stage)) return { readyQty: reserved, issuedQty: 0 };
    return { readyQty: 0, issuedQty: 0 };
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

async function describeLines(lines, allowedStoreIds) {
    const visible = filterStores(allowedStoreIds, lines, 'storeId');
    const itemIds = [...new Set(visible.map((l) => l.itemId))];
    const storeIds = [...new Set(visible.map((l) => l.storeId).filter(Boolean))];
    const items = new Map((await MatWhItem.findAll({ where: { id: itemIds.length ? itemIds : [-1] } })).map((i) => [i.id, i]));
    const stores = new Map((await MatWhStore.findAll({ where: { id: storeIds.length ? storeIds : [-1] } })).map((s) => [s.id, s]));
    return { visible, items, stores };
}

// One plan with its lines: last check snapshot for lines not requested
// yet, stage and progress for requested ones.
export async function planDetail(planId, allowedStoreIds) {
    const plan = await loadPlan(planId);
    const lines = await MatWhProjectPlanItem.findAll({ where: { planId: plan.id }, order: [['id', 'ASC']] });
    return (await summarizePlans([plan], lines, allowedStoreIds))[0];
}

// A plan line's stage: 'checking' until production requests it, then
// 'requested' (with the store) until every reservation line issued for it
// is handed over -> 'issued'.
async function summarizePlans(plans, allLines, allowedStoreIds) {
    const { visible, items, stores } = await describeLines(allLines, allowedStoreIds);
    const requestedIds = visible.filter((l) => l.requestedDate).map((l) => l.id);
    const resLines = requestedIds.length
        ? await MatWhReservationItem.findAll({ where: { issueRequestPlanItemId: requestedIds } })
        : [];
    const resByPlanLine = new Map();
    for (const r of resLines) {
        if (!resByPlanLine.has(r.issueRequestPlanItemId)) resByPlanLine.set(r.issueRequestPlanItemId, []);
        resByPlanLine.get(r.issueRequestPlanItemId).push(r);
    }
    return plans.map((plan) => {
        let planned = 0, requested = 0, issued = 0;
        const lines = visible.filter((l) => l.planId === plan.id).map((l) => {
            const linked = resByPlanLine.get(l.id) ?? [];
            const qty = Number(l.qtyPlanned);
            const issuedQty = linked.filter((r) => r.status === 'issued').reduce((s, r) => s + Number(r.qtyReserved), 0);
            let stage = 'checking';
            if (l.requestedDate) stage = issuedQty >= qty ? 'issued' : 'requested';
            planned += qty;
            if (l.requestedDate) requested += qty;
            issued += Math.min(qty, issuedQty);
            const item = items.get(l.itemId);
            const store = l.storeId ? stores.get(l.storeId) : null;
            return {
                ...l.toJSON(),
                itemCode: item?.itemCode ?? null, itemName: item?.itemName ?? null, itemNameAr: item?.itemNameAr ?? null,
                category: item?.category ?? null,
                storeName: store?.storeName ?? null, storeNameAr: store?.storeNameAr ?? null,
                stage, requestable: !l.requestedDate && l.checkStatus === 'ready',
                requestedQty: l.requestedDate ? qty : 0, issuedQty,
            };
        });
        return {
            ...plan.toJSON(), lines,
            lineCount: lines.length,
            requestedPct: pct(requested, planned), issuedPct: pct(issued, planned),
        };
    });
}

export async function listPlans({ projectId, status, q }, allowedStoreIds) {
    const where = {};
    if (projectId) where.projectId = projectId;
    if (status) where.status = status;
    if (q) {
        where[Op.or] = [
            { planNo: { [Op.like]: `%${q}%` } }, { projectNo: { [Op.like]: `%${q}%` } },
            { projectName: { [Op.like]: `%${q}%` } }, { orderRef: { [Op.like]: `%${q}%` } },
        ];
    }
    const plans = await MatWhProjectPlan.findAll({ where, order: [['plannedStartDate', 'ASC'], ['id', 'DESC']], limit: 200 });
    if (plans.length === 0) return [];
    const lines = await MatWhProjectPlanItem.findAll({ where: { planId: plans.map((p) => p.id) } });
    // The list carries the totals only, not every line.
    return (await summarizePlans(plans, lines, allowedStoreIds)).map(({ lines: _l, ...p }) => p); // eslint-disable-line no-unused-vars
}

// Everything for one project: its reservations (what the projects
// department asked the stores to hold, each line with its stage) and each
// production order's plan with what was requested and issued.
export async function projectStatus(projectId, allowedStoreIds) {
    const plans = await MatWhProjectPlan.findAll({ where: { projectId }, order: [['plannedStartDate', 'ASC'], ['id', 'ASC']] });
    const planLines = plans.length
        ? await MatWhProjectPlanItem.findAll({ where: { planId: plans.map((p) => p.id) }, order: [['id', 'ASC']] })
        : [];
    const summarized = await summarizePlans(plans, planLines, allowedStoreIds);

    const headers = await MatWhReservationHeader.findAll({
        where: { projectId, status: { [Op.ne]: 'draft' } }, order: [['id', 'ASC']],
    });
    const reqLines = headers.length
        ? await MatWhReservationItem.findAll({ where: { reservationHeaderId: headers.map((h) => h.id) }, order: [['id', 'ASC']] })
        : [];
    const { visible, items, stores } = await describeLines(reqLines, allowedStoreIds);
    const otherRequests = headers.map((h) => {
        const lines = visible.filter((l) => l.reservationHeaderId === h.id).map((l) => {
            const stage = lineStage(h, l);
            const item = items.get(l.itemId);
            const store = stores.get(l.storeId);
            return {
                id: l.id, itemId: l.itemId, itemCode: item?.itemCode ?? null, itemName: item?.itemName ?? null,
                itemNameAr: item?.itemNameAr ?? null, storeName: store?.storeName ?? null, storeNameAr: store?.storeNameAr ?? null,
                color: l.color, lengthMm: l.lengthMm, qtyRequested: Number(l.qtyRequested),
                qtyReserved: Number(l.qtyReserved), stage, ...lineProgress(stage, l),
            };
        });
        return { id: h.id, reservationNo: h.reservationNo, status: h.status, createdAt: h.createdAt, lines };
    }).filter((h) => h.lines.length > 0);

    // Reservation readiness: reserved (ready, requested or issued) out of
    // everything the reservations asked for; issued out of the orders' plans.
    let asked = 0, ready = 0, planned = 0, issued = 0;
    for (const h of otherRequests) {
        for (const l of h.lines) {
            if (['rejected', 'released'].includes(l.stage)) continue;
            asked += l.qtyRequested;
            ready += Math.min(l.qtyRequested, l.readyQty);
        }
    }
    for (const p of summarized) {
        for (const l of p.lines) {
            planned += Number(l.qtyPlanned);
            issued += Math.min(Number(l.qtyPlanned), l.issuedQty);
        }
    }
    return {
        projectId: Number(projectId),
        projectNo: plans[0]?.projectNo ?? headers[0]?.projectNo ?? null,
        projectName: plans[0]?.projectName ?? headers[0]?.projectName ?? null,
        plans: summarized, otherRequests,
        readyPct: pct(ready, asked), issuedPct: pct(issued, planned),
    };
}
