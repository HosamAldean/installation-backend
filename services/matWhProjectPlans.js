// backend/services/matWhProjectPlans.js
// Project material plans (2026-11-01) -- see models/MatWhProjectPlan.js.
//
// Production keeps one plan per order / phase of a project, fills its
// lines from an Excel paste or the grid, checks them against the stores
// before the planned start date and requests all or some of them. Checking
// is warn-only: nothing is held, so two plans can both read "available"
// for the same stock -- checkCompeting says how much earlier plans want.
//
// After a line is requested its progress comes from the production request
// line it became (lineStage below), not from the check.
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
import { MatWhPurchaseOrder } from '../models/MatWhPurchaseOrder.js';
import { MatWhPurchaseOrderItem } from '../models/MatWhPurchaseOrderItem.js';
import { MatWhGoodsReceiptItem } from '../models/MatWhGoodsReceiptItem.js';
import { MatWhExternalProcessing } from '../models/MatWhExternalProcessing.js';
import { getAvailableToReserve, normalizeColor } from './matWhLedger.js';
import { filterStores } from './matWhStoreAccess.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

const OPEN_PLAN_STATUSES = ['draft', 'active'];
// A request line in one of these can be requested again from the plan.
const RE_REQUESTABLE = ['rejected', 'released'];

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
        if (storeId && allowedStoreIds !== null && !allowedStoreIds.includes(storeId)) {
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
    if (line.reservationItemId) {
        const reqLine = await MatWhReservationItem.findByPk(line.reservationItemId);
        if (reqLine && !RE_REQUESTABLE.includes(reqLine.status)) {
            throw httpError(409, 'This line is already requested -- change it on the production request');
        }
    }
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
            if (allowedStoreIds !== null && !allowedStoreIds.includes(storeId)) throw httpError(403, 'You have no access to that store');
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

// Open PO quantity still to arrive per PO line, leaving out lines an
// existing request's shortfall already raised (that stock is spoken for).
async function freeIncoming(itemIds) {
    if (itemIds.length === 0) return [];
    const poItems = await MatWhPurchaseOrderItem.findAll({ where: { itemId: itemIds } });
    if (poItems.length === 0) return [];
    const pos = await MatWhPurchaseOrder.findAll({
        where: { id: [...new Set(poItems.map((p) => p.purchaseOrderId))], status: { [Op.notIn]: ['closed', 'cancelled'] } },
    });
    const poById = new Map(pos.map((p) => [p.id, p]));
    const claimed = new Set((await MatWhReservationItem.findAll({
        where: { purchaseOrderItemId: poItems.map((p) => p.id) }, attributes: ['purchaseOrderItemId'],
    })).map((r) => r.purchaseOrderItemId));
    const received = new Map();
    for (const gr of await MatWhGoodsReceiptItem.findAll({ where: { poItemId: poItems.map((p) => p.id) } })) {
        received.set(gr.poItemId, (received.get(gr.poItemId) ?? 0) + Number(gr.qtyAccepted ?? 0));
    }
    return poItems
        .filter((p) => poById.has(p.purchaseOrderId) && !claimed.has(p.id))
        .map((p) => ({
            itemId: p.itemId, storeId: poById.get(p.purchaseOrderId).destinationStoreId,
            // A mill-finish line bought for coating counts toward its target colour.
            color: p.targetColor || p.color || null, lengthMm: p.lengthMm,
            qty: Math.max(0, Number(p.qtyOrdered) - (received.get(p.id) ?? 0)),
            eta: poById.get(p.purchaseOrderId).eta,
        }))
        .filter((p) => p.qty > 0);
}

// Material out at coating (or waiting to go) that no request line is
// waiting for.
async function freeAtCoating(itemIds) {
    if (itemIds.length === 0) return [];
    const jobs = await MatWhExternalProcessing.findAll({
        where: {
            itemId: itemIds, status: ['draft', 'sent'], sourceReservationItemId: null,
            approvalStatus: { [Op.ne]: 'rejected' },
        },
    });
    return jobs.map((j) => ({ itemId: j.itemId, storeId: j.storeId, color: j.targetColor, lengthMm: j.lengthMm, qty: Number(j.qtySent) }));
}

const requestable = (line, reqLineById) => {
    if (!line.reservationItemId) return true;
    const reqLine = reqLineById.get(line.reservationItemId);
    return !reqLine || RE_REQUESTABLE.includes(reqLine.status);
};

// Re-reads every not-yet-requested line against the stores and saves the
// snapshot on the line. Never earmarks anything.
export async function checkPlan(planId) {
    const plan = await loadPlan(planId);
    const lines = await MatWhProjectPlanItem.findAll({ where: { planId: plan.id }, order: [['id', 'ASC']] });
    const reqLineById = await requestLinesById(lines);
    const toCheck = lines.filter((l) => requestable(l, reqLineById));
    const itemIds = [...new Set(toCheck.map((l) => l.itemId))];
    const items = new Map((await MatWhItem.findAll({ where: { id: itemIds.length ? itemIds : [-1] } })).map((i) => [i.id, i]));
    const incoming = await freeIncoming(itemIds);
    const atCoating = await freeAtCoating(itemIds);

    // Other open plans starting no later than this one, lines not yet requested.
    const otherPlans = await MatWhProjectPlan.findAll({
        where: { id: { [Op.ne]: plan.id }, status: OPEN_PLAN_STATUSES },
    });
    const earlierPlanIds = otherPlans
        .filter((p) => !plan.plannedStartDate || !p.plannedStartDate || p.plannedStartDate <= plan.plannedStartDate)
        .map((p) => p.id);
    const otherLines = earlierPlanIds.length && itemIds.length
        ? await MatWhProjectPlanItem.findAll({ where: { planId: earlierPlanIds, itemId: itemIds, reservationItemId: null } })
        : [];

    const matches = (line) => (r) => r.itemId === line.itemId && r.storeId === line.storeId
        && sameColor(r.color, line.color) && sameLength(r.lengthMm, line.lengthMm);
    const sum = (rows) => rows.reduce((s, r) => s + Number(r.qty ?? r.qtyPlanned ?? 0), 0);

    for (const line of toCheck) {
        if (!line.storeId) {
            await line.update({
                checkStatus: 'no_store', checkAvailable: null, checkMill: null, checkIncoming: null,
                checkAtCoating: null, checkCompeting: null, checkIncomingEta: null,
            });
            continue;
        }
        const color = normalizeColor(line.color);
        const available = await getAvailableToReserve(line.storeId, line.itemId, color ?? undefined, line.lengthMm ?? undefined);
        const painted = items.get(line.itemId)?.category === 'ALM' && !!color;
        const mill = painted
            ? await getAvailableToReserve(line.storeId, line.itemId, null, line.lengthMm ?? undefined)
            : 0;
        const inc = incoming.filter(matches(line));
        const coat = atCoating.filter(matches(line));
        const incomingQty = sum(inc);
        const coatingQty = sum(coat);
        const competing = sum(otherLines.filter((o) => o.itemId === line.itemId && o.storeId === line.storeId
            && sameColor(o.color, line.color) && sameLength(o.lengthMm, line.lengthMm))
            .map((o) => ({ qty: o.qtyPlanned })));
        const need = Number(line.qtyPlanned);
        let status = 'short';
        if (available >= need) status = 'available';
        else if (available + mill >= need) status = 'from_mill';
        else if (available + mill + coatingQty + incomingQty >= need) status = 'incoming';
        const etas = inc.map((r) => r.eta).filter(Boolean).sort();
        await line.update({
            checkStatus: status, checkAvailable: available, checkMill: painted ? mill : null,
            checkIncoming: incomingQty, checkAtCoating: coatingQty, checkCompeting: competing,
            checkIncomingEta: etas[0] ?? null,
        });
    }
    await plan.update({ lastCheckedAt: new Date() });
    return plan;
}

async function requestLinesById(lines) {
    const ids = [...new Set(lines.map((l) => l.reservationItemId).filter(Boolean))];
    if (ids.length === 0) return new Map();
    return new Map((await MatWhReservationItem.findAll({ where: { id: ids } })).map((r) => [r.id, r]));
}

// Creates one production request from the chosen lines (all requestable
// lines when lineIds is null) and submits it -- to the production manager
// first when the caller needs that approval, like the request page.
export async function requestPlanLines(planId, lineIds, user, needsApproval, allowedStoreIds) {
    const plan = await loadPlan(planId);
    assertEditable(plan);
    const lines = await MatWhProjectPlanItem.findAll({ where: { planId: plan.id }, order: [['id', 'ASC']] });
    const reqLineById = await requestLinesById(lines);
    const wanted = lineIds ? new Set(lineIds.map(Number)) : null;
    const chosen = lines.filter((l) => requestable(l, reqLineById) && (!wanted || wanted.has(l.id)));
    if (chosen.length === 0) throw httpError(400, 'No lines to request -- they are all requested already');
    const items = new Map((await MatWhItem.findAll({ where: { id: [...new Set(chosen.map((l) => l.itemId))] } })).map((i) => [i.id, i]));
    const noStore = chosen.filter((l) => !l.storeId);
    if (noStore.length) {
        throw httpError(400, `Pick a store first for: ${noStore.map((l) => items.get(l.itemId)?.itemCode ?? l.itemId).join(', ')}`);
    }
    if (allowedStoreIds !== null) {
        const outside = chosen.filter((l) => !allowedStoreIds.includes(l.storeId));
        if (outside.length) throw httpError(403, 'Some lines are in a store you have no access to');
    }

    return sequelizeUtf8.transaction(async (t) => {
        const placeholder = `TMP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const header = await MatWhReservationHeader.create({
            reservationNo: placeholder,
            projectId: plan.projectId, projectNo: plan.projectNo, projectName: plan.projectName,
            projectManager: plan.projectManager, reservationDate: new Date(),
            notes: `${plan.planNo} -- ${plan.orderRef}`.slice(0, 500),
            status: 'draft', createdBy: user.userId, projectPlanId: plan.id,
        }, { transaction: t });
        await header.update({ reservationNo: `PRQ-${String(header.id).padStart(6, '0')}` }, { transaction: t });
        for (const line of chosen) {
            const reqLine = await MatWhReservationItem.create({
                reservationHeaderId: header.id, itemId: line.itemId, storeId: line.storeId,
                itemNeededByDate: line.neededByDate ?? plan.plannedStartDate ?? null,
                color: line.color || null, lengthMm: line.lengthMm || null,
                qtyRequested: line.qtyPlanned, status: 'pending',
            }, { transaction: t });
            await line.update({ reservationHeaderId: header.id, reservationItemId: reqLine.id }, { transaction: t });
        }
        // Same one-way door as POST /reservations/:id/submit.
        await header.update({ status: needsApproval ? 'pending_approval' : 'submitted' }, { transaction: t });
        if (plan.status === 'draft') await plan.update({ status: 'active' }, { transaction: t });
        return { reservationId: header.id, reservationNo: header.reservationNo, lines: chosen.length };
    });
}

// Where a requested line has got to, from its request line and header.
export function lineStage(header, reqLine) {
    if (!header || !reqLine) return 'not_requested';
    if (header.status === 'draft') return 'draft';
    if (header.status === 'pending_approval') return 'production_approval';
    if (header.status === 'rejected' && header.productionRejectedBy) return 'rejected';
    switch (reqLine.status) {
        case 'pending': return 'with_store';
        case 'rejected': return 'rejected';
        case 'released': return 'released';
        case 'issued': return 'issued';
        default:
            if (reqLine.managerApprovalStatus === 'pending_manager') return 'manager_approval';
            if (Number(reqLine.qtyReserved) >= Number(reqLine.qtyRequested)) return 'ready';
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
    if (['ready', 'at_coating', 'purchasing'].includes(stage)) return { readyQty: reserved, issuedQty: 0 };
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

async function summarizePlans(plans, allLines, allowedStoreIds) {
    const { visible, items, stores } = await describeLines(allLines, allowedStoreIds);
    const reqLineById = await requestLinesById(visible);
    const headerIds = [...new Set([...reqLineById.values()].map((r) => r.reservationHeaderId))];
    const headerById = new Map((await MatWhReservationHeader.findAll({ where: { id: headerIds.length ? headerIds : [-1] } }))
        .map((h) => [h.id, h]));
    return plans.map((plan) => {
        let planned = 0, ready = 0, issued = 0, requested = 0;
        const lines = visible.filter((l) => l.planId === plan.id).map((l) => {
            const reqLine = l.reservationItemId ? reqLineById.get(l.reservationItemId) : null;
            const header = reqLine ? headerById.get(reqLine.reservationHeaderId) : null;
            const stage = lineStage(header, reqLine);
            const progress = lineProgress(stage, reqLine);
            const qty = Number(l.qtyPlanned);
            planned += qty;
            ready += Math.min(qty, progress.readyQty);
            issued += Math.min(qty, progress.issuedQty);
            if (stage !== 'not_requested' && !RE_REQUESTABLE.includes(stage)) requested += qty;
            const item = items.get(l.itemId);
            const store = l.storeId ? stores.get(l.storeId) : null;
            return {
                ...l.toJSON(),
                itemCode: item?.itemCode ?? null, itemName: item?.itemName ?? null, itemNameAr: item?.itemNameAr ?? null,
                category: item?.category ?? null,
                storeName: store?.storeName ?? null, storeNameAr: store?.storeNameAr ?? null,
                stage, requestable: requestable(l, reqLineById),
                reservationNo: header?.reservationNo ?? null,
                qtyReserved: reqLine ? Number(reqLine.qtyReserved) : null,
                qtyPendingCoating: reqLine ? Number(reqLine.qtyPendingCoating) : null,
                qtyShortfall: reqLine ? Number(reqLine.qtyShortfall) : null,
                readyQty: progress.readyQty, issuedQty: progress.issuedQty,
                lateIncoming: !!(l.checkIncomingEta && plan.plannedStartDate && l.checkIncomingEta > plan.plannedStartDate),
            };
        });
        return {
            ...plan.toJSON(), lines,
            lineCount: lines.length,
            requestedPct: pct(requested, planned), readyPct: pct(ready, planned), issuedPct: pct(issued, planned),
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

// Everything a project has asked the stores for: each plan with its lines,
// plus requests raised outside a plan, with each line's stage.
export async function projectStatus(projectId, allowedStoreIds) {
    const plans = await MatWhProjectPlan.findAll({ where: { projectId }, order: [['plannedStartDate', 'ASC'], ['id', 'ASC']] });
    const planLines = plans.length
        ? await MatWhProjectPlanItem.findAll({ where: { planId: plans.map((p) => p.id) }, order: [['id', 'ASC']] })
        : [];
    const summarized = await summarizePlans(plans, planLines, allowedStoreIds);

    const headers = await MatWhReservationHeader.findAll({
        where: { projectId, projectPlanId: null, status: { [Op.ne]: 'draft' } }, order: [['id', 'ASC']],
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

    let planned = 0, ready = 0, issued = 0;
    for (const p of summarized) {
        for (const l of p.lines) {
            planned += Number(l.qtyPlanned);
            ready += Math.min(Number(l.qtyPlanned), l.readyQty);
            issued += Math.min(Number(l.qtyPlanned), l.issuedQty);
        }
    }
    return {
        projectId: Number(projectId),
        projectNo: plans[0]?.projectNo ?? headers[0]?.projectNo ?? null,
        projectName: plans[0]?.projectName ?? headers[0]?.projectName ?? null,
        plans: summarized, otherRequests,
        readyPct: pct(ready, planned), issuedPct: pct(issued, planned),
    };
}
