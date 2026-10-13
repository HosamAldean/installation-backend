// backend/services/matWhStockCount.js
// Stock Count (جرد) -- sheet generation, counting, review and the approval
// that posts the variance adjustments. Status flow and the blind-count /
// snapshot-at-count design are documented on the two models
// (MatWhStockCount.js, MatWhStockCountLine.js); routes live in
// routes/materialsWarehouseStockCount.js.
import { Op, QueryTypes } from 'sequelize';
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhStockCount } from '../models/MatWhStockCount.js';
import { MatWhStockCountLine } from '../models/MatWhStockCountLine.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { MatWhItemCost } from '../models/MatWhItemCost.js';
import {
    postLedgerMovement, applyReceiptCost, getPhysicalBalance, getAlreadyReserved, normalizeColor,
} from './matWhLedger.js';

const OPEN_STATUSES = ['counting', 'submitted'];

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// One key per ledger granularity -- color already normalized (MILL -> null),
// length as a plain number or null.
function lineKey(itemId, color, lengthMm) {
    return `${itemId}|${normalizeColor(color ?? null) ?? ''}|${lengthMm ?? ''}`;
}

async function nextCountNo(transaction) {
    const prefix = `SC-${new Date().getFullYear()}-`;
    const last = await MatWhStockCount.findOne({
        where: { countNo: { [Op.like]: `${prefix}%` } },
        order: [['countNo', 'DESC']],
        transaction,
    });
    const lastSeq = last ? Number(last.countNo.slice(prefix.length)) || 0 : 0;
    return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;
}

// Builds the sheet: every active item linked to the store (inner join to
// matWhItems, so item-store rows whose item no longer exists are skipped),
// expanded to one line per active variant for items that have variants,
// plus every item/color/length the ledger says still has a non-zero
// balance in this store -- stock nobody linked to the store still has to
// be counted.
async function buildSheetLines(storeId, scopeCategory, scopeZone) {
    const linked = await sequelizeUtf8.query(
        `SELECT s.itemId, s.zone, s.locationColumn, s.locationRow
           FROM matWhItemStores s
           JOIN matWhItems i ON i.id = s.itemId
          WHERE s.storeId = :storeId AND i.isActive = 1
            ${scopeCategory ? 'AND i.category = :scopeCategory' : ''}
            ${scopeZone ? 'AND s.zone = :scopeZone' : ''}`,
        { replacements: { storeId, scopeCategory, scopeZone }, type: QueryTypes.SELECT },
    );
    const balances = await sequelizeUtf8.query(
        `SELECT l.itemId, l.color, l.lengthMm,
                SUM(CASE WHEN l.direction = 'in' THEN l.qty ELSE -l.qty END) AS balance,
                s.zone, s.locationColumn, s.locationRow
           FROM matWhStockLedger l
           JOIN matWhItems i ON i.id = l.itemId
           LEFT JOIN matWhItemStores s ON s.itemId = l.itemId AND s.storeId = l.storeId
          WHERE l.storeId = :storeId
            ${scopeCategory ? 'AND i.category = :scopeCategory' : ''}
            ${scopeZone ? 'AND s.zone = :scopeZone' : ''}
          GROUP BY l.itemId, l.color, l.lengthMm, s.zone, s.locationColumn, s.locationRow
         HAVING ABS(balance) > 0.000001`,
        { replacements: { storeId, scopeCategory, scopeZone }, type: QueryTypes.SELECT },
    );

    const itemIds = [...new Set(linked.map((r) => r.itemId))];
    const variants = itemIds.length
        ? await MatWhItemVariant.findAll({ where: { itemId: itemIds, isActive: true } })
        : [];
    const variantsByItem = new Map();
    for (const v of variants) {
        if (!variantsByItem.has(v.itemId)) variantsByItem.set(v.itemId, []);
        variantsByItem.get(v.itemId).push(v);
    }

    const lines = new Map();
    const add = (itemId, color, lengthMm, loc) => {
        const key = lineKey(itemId, color, lengthMm);
        if (lines.has(key)) return;
        lines.set(key, {
            itemId,
            color: normalizeColor(color ?? null) ?? null,
            lengthMm: lengthMm ?? null,
            zone: loc.zone ?? null,
            locationColumn: loc.locationColumn ?? null,
            locationRow: loc.locationRow ?? null,
        });
    };
    for (const row of linked) {
        const itemVariants = variantsByItem.get(row.itemId);
        if (itemVariants?.length) {
            for (const v of itemVariants) add(row.itemId, v.color, v.lengthMm, row);
        } else {
            add(row.itemId, null, null, row);
        }
    }
    for (const row of balances) add(row.itemId, row.color, row.lengthMm, row);
    return [...lines.values()];
}

export async function createStockCount({ storeId, scopeCategory, scopeZone, notes, createdBy }) {
    const open = await MatWhStockCount.findOne({ where: { storeId, status: OPEN_STATUSES } });
    if (open) {
        throw httpError(409, `Store already has an open count (${open.countNo}) -- finish or cancel it first`);
    }
    const sheet = await buildSheetLines(storeId, scopeCategory || null, scopeZone || null);
    if (sheet.length === 0) {
        throw httpError(400, 'No items found for this store and scope -- link items to the store in Master Data first');
    }

    const t = await sequelizeUtf8.transaction();
    try {
        const count = await MatWhStockCount.create({
            countNo: await nextCountNo(t), storeId,
            scopeCategory: scopeCategory || null, scopeZone: scopeZone || null,
            notes: notes || null, createdBy: createdBy ?? null, status: 'counting',
        }, { transaction: t });
        await MatWhStockCountLine.bulkCreate(
            sheet.map((l) => ({ ...l, stockCountId: count.id })),
            { transaction: t },
        );
        await t.commit();
        return count;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

async function loadCount(id, expectedStatus) {
    const count = await MatWhStockCount.findByPk(id);
    if (!count) throw httpError(404, 'Stock count not found');
    if (expectedStatus && count.status !== expectedStatus) {
        throw httpError(409, `Not allowed while the count is '${count.status}'`);
    }
    return count;
}

// While a recount is in progress (any line flagged needsRecount), only
// the flagged lines are open -- everything else was already accepted.
// The flags stay set until the next submit, so saving a recounted line
// doesn't reopen the rest of the sheet.
async function isRecountMode(stockCountId) {
    return (await MatWhStockCountLine.count({ where: { stockCountId, needsRecount: true } })) > 0;
}

async function snapshotAndCount(count, line, countedQty, countedBy) {
    const systemQty = await getPhysicalBalance(count.storeId, line.itemId, line.color, line.lengthMm);
    return line.update({
        countedQty, systemQty, varianceQty: countedQty - systemQty,
        countedBy: countedBy ?? null, countedAt: new Date(),
    });
}

function parseQty(value) {
    const qty = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(qty) || qty < 0) {
        throw httpError(400, 'countedQty must be a number of 0 or more');
    }
    return qty;
}

export async function countLine(stockCountId, lineId, countedQty, countedBy) {
    const count = await loadCount(stockCountId, 'counting');
    const line = await MatWhStockCountLine.findOne({ where: { id: lineId, stockCountId } });
    if (!line) throw httpError(404, 'Line not found');
    if ((await isRecountMode(stockCountId)) && !line.needsRecount) {
        throw httpError(409, 'Only the lines sent back for recount can be changed');
    }
    return snapshotAndCount(count, line, parseQty(countedQty), countedBy);
}

// A real item found on the shelf that the sheet didn't list. If the exact
// item/color/length is already on the sheet, that line is counted instead.
export async function addExtraLine(stockCountId, { itemId, color, lengthMm, countedQty }, countedBy) {
    const count = await loadCount(stockCountId, 'counting');
    const qty = parseQty(countedQty);
    const item = await MatWhItem.findByPk(itemId);
    if (!item) throw httpError(404, 'Item not found');
    const normalizedColor = normalizeColor(color || null) ?? null;
    const length = lengthMm != null && lengthMm !== '' ? Number(lengthMm) : null;
    const existing = await MatWhStockCountLine.findOne({
        where: { stockCountId, itemId, color: normalizedColor, lengthMm: length },
    });
    if (existing) return countLine(stockCountId, existing.id, qty, countedBy);
    if (await isRecountMode(stockCountId)) {
        throw httpError(409, 'Only the lines sent back for recount can be changed');
    }
    const line = await MatWhStockCountLine.create({
        stockCountId, itemId, color: normalizedColor, lengthMm: length, isExtra: true,
    });
    return snapshotAndCount(count, line, qty, countedBy);
}

// Resolves a scanned code to a sheet line: a variant barcode first (exact
// item+color+length), then an item barcode or item code (plain items).
// Returns { line } when it's on the sheet, otherwise { item, color,
// lengthMm } so the caller can offer "add found item".
export async function lookupBarcode(stockCountId, code) {
    await loadCount(stockCountId);
    let itemId; let color = null; let lengthMm = null;
    const variant = await MatWhItemVariant.findOne({ where: { barcode: code, isActive: true } });
    if (variant) {
        itemId = variant.itemId;
        color = normalizeColor(variant.color ?? null) ?? null;
        lengthMm = variant.lengthMm ?? null;
    } else {
        const item = await MatWhItem.findOne({
            where: { [Op.or]: [{ barcode: code }, { itemCode: code }] },
        });
        if (!item) throw httpError(404, 'Barcode not recognized');
        itemId = item.id;
    }
    const line = await MatWhStockCountLine.findOne({
        where: { stockCountId, itemId, color, lengthMm },
    });
    if (line) return { line };
    const item = await MatWhItem.findByPk(itemId);
    return {
        line: null,
        item: { id: item.id, itemCode: item.itemCode, itemName: item.itemName, itemNameAr: item.itemNameAr, baseUnit: item.baseUnit },
        color, lengthMm,
    };
}

export async function submitStockCount(stockCountId, submittedBy) {
    const count = await loadCount(stockCountId, 'counting');
    const uncounted = await MatWhStockCountLine.count({ where: { stockCountId, countedQty: null } });
    if (uncounted > 0) {
        throw httpError(400, `${uncounted} line(s) not counted yet -- enter 0 for anything not found`);
    }
    await MatWhStockCountLine.update({ needsRecount: false }, { where: { stockCountId, needsRecount: true } });
    return count.update({ status: 'submitted', submittedBy: submittedBy ?? null, submittedAt: new Date() });
}

export async function cancelStockCount(stockCountId) {
    const count = await loadCount(stockCountId, 'counting');
    return count.update({ status: 'cancelled' });
}

// Sends chosen lines back for a blind recount: their previous count is
// cleared so the counter starts fresh, every other line stays accepted.
export async function recountLines(stockCountId, lineIds, decidedBy, notes) {
    const count = await loadCount(stockCountId, 'submitted');
    if (!Array.isArray(lineIds) || lineIds.length === 0) throw httpError(400, 'Choose at least one line to recount');
    const [updated] = await MatWhStockCountLine.update(
        { needsRecount: true, countedQty: null, systemQty: null, varianceQty: null, countedBy: null, countedAt: null },
        { where: { stockCountId, id: lineIds } },
    );
    if (updated === 0) throw httpError(400, 'None of those lines belong to this count');
    return count.update({ status: 'counting', decisionNotes: notes ?? count.decisionNotes });
}

export async function rejectStockCount(stockCountId, decidedBy, notes) {
    const count = await loadCount(stockCountId, 'submitted');
    return count.update({ status: 'rejected', decidedBy: decidedBy ?? null, decidedAt: new Date(), decisionNotes: notes ?? null });
}

// Lines whose approval would leave more already reserved than physically
// left in stock -- shown to the approver as a warning, never a block (the
// count is the truth; the reservations are what needs fixing).
export async function reservationWarnings(count, lines) {
    const warnings = [];
    for (const line of lines) {
        if (!(line.varianceQty < 0)) continue;
        const [physical, reserved] = await Promise.all([
            getPhysicalBalance(count.storeId, line.itemId, line.color, line.lengthMm),
            getAlreadyReserved(count.storeId, line.itemId, undefined, line.color, line.lengthMm),
        ]);
        const after = physical + line.varianceQty;
        if (reserved > after) warnings.push({ lineId: line.id, reserved, physicalAfter: after });
    }
    return warnings;
}

// The real stock event: one ledger movement per non-zero variance, all or
// nothing. unitCosts is { [lineId]: cost } -- the approver's cost for
// positive variances on items with no known cost (a store's first count).
export async function approveStockCount(stockCountId, decidedBy, { unitCosts, notes } = {}) {
    const count = await loadCount(stockCountId, 'submitted');
    const lines = await MatWhStockCountLine.findAll({ where: { stockCountId } });
    const warnings = await reservationWarnings(count, lines);

    const t = await sequelizeUtf8.transaction();
    try {
        for (const line of lines) {
            const variance = line.varianceQty ?? 0;
            if (Math.abs(variance) < 0.000001) continue;
            const rawCost = unitCosts?.[line.id];
            const unitCost = rawCost !== undefined && rawCost !== null && rawCost !== '' ? Number(rawCost) : null;
            const ledgerRow = await postLedgerMovement({
                storeId: count.storeId, itemId: line.itemId,
                qty: Math.abs(variance), direction: variance > 0 ? 'in' : 'out',
                docType: 'stock_count_adjust', refType: 'stock_count_line', refId: line.id,
                unitCost: variance > 0 ? unitCost : null,
                performedBy: decidedBy, color: line.color, lengthMm: line.lengthMm,
            }, t);
            if (variance > 0 && unitCost != null && Number.isFinite(unitCost)) {
                await applyReceiptCost(line.itemId, count.storeId, variance, unitCost, t);
            }
            await line.update({ ledgerEntryId: ledgerRow.id, unitCost: variance > 0 ? unitCost : null }, { transaction: t });
        }
        await count.update({
            status: 'approved', decidedBy: decidedBy ?? null, decidedAt: new Date(),
            decisionNotes: notes ?? null,
        }, { transaction: t });
        await t.commit();
        return { count, warnings };
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

// Current cost per item in this store, for the approver's value column.
export async function currentCosts(storeId, itemIds) {
    if (itemIds.length === 0) return new Map();
    const rows = await MatWhItemCost.findAll({ where: { storeId, itemId: itemIds } });
    return new Map(rows.map((r) => [r.itemId, r.currentCost]));
}
