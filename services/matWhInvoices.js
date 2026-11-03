// backend/services/matWhInvoices.js
// Invoice math shared by the warehouse and Mix's portal (2026-10-29), so a
// preview, a saved invoice and an approval always compute the same way.
//
// Purchase invoices -- landed cost: line prices are in the invoice's
// currency; the header discount is spread over the lines by value, extra
// costs (freight, customs, ...) are converted to JOD and spread by value
// too, and VAT stays out of item cost. landedUnitCost (JOD) is what a
// matched receipt line's finalUnitCost becomes.
//
// Coating invoices -- Mix prices per kg: one line per coating job, weight
// defaulting to qty x the variant's unitWeight (kg per bar).
import { sequelizeUtf8 } from '../config/db.js';
import { MatWhCoatingInvoice } from '../models/MatWhCoatingInvoice.js';
import { MatWhCoatingInvoiceItem } from '../models/MatWhCoatingInvoiceItem.js';
import { MatWhExternalProcessing } from '../models/MatWhExternalProcessing.js';
import { MatWhItem } from '../models/MatWhItem.js';
import { MatWhItemVariant } from '../models/MatWhItemVariant.js';
import { MatWhPurchaseOrderItem } from '../models/MatWhPurchaseOrderItem.js';
import { MatWhGoodsReceipt } from '../models/MatWhGoodsReceipt.js';
import { MatWhGoodsReceiptItem } from '../models/MatWhGoodsReceiptItem.js';
import { SUPPLIER_INVOICE_EXTRA_TYPES } from '../models/MatWhSupplierInvoiceExtra.js';
import { normalizeColor } from './matWhLedger.js';

const round = (n, dp = 4) => Math.round(Number(n) * 10 ** dp) / 10 ** dp;
const num = (v, fallback = 0) => (v === undefined || v === null || v === '' ? fallback : Number(v));

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// Everything a purchase invoice stores, computed from the request body and
// the PO -- never saved here. Throws 400 on invalid input; price/qty
// differences against the PO come back as warnings, not errors.
export async function computeSupplierInvoice(po, body) {
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) throw badRequest('At least one item is required');

    const currency = String(body.currency || 'JOD').trim().toUpperCase() || 'JOD';
    const exchangeRate = currency === 'JOD' ? 1 : num(body.exchangeRate, NaN);
    if (!(exchangeRate > 0)) throw badRequest('Exchange rate to JOD is required for a foreign-currency invoice');

    const poItems = await MatWhPurchaseOrderItem.findAll({ where: { purchaseOrderId: po.id } });
    const poItemById = new Map(poItems.map((p) => [p.id, p]));

    const lines = items.map((line, i) => {
        const qty = num(line.qty, NaN);
        const unitPrice = num(line.unitPrice, NaN);
        if (!line.itemId || !(qty > 0) || !(unitPrice >= 0)) throw badRequest(`Line ${i + 1}: item, qty and unit price are required`);
        // An explicit poItemId must belong to this PO; otherwise the only
        // PO line for this item, when there's exactly one.
        let poItem = line.poItemId ? poItemById.get(Number(line.poItemId)) : null;
        if (line.poItemId && !poItem) throw badRequest(`Line ${i + 1}: that PO line is not on this purchase order`);
        if (!poItem) {
            const sameItem = poItems.filter((p) => p.itemId === Number(line.itemId));
            if (sameItem.length === 1) [poItem] = sameItem;
        }
        return { itemId: Number(line.itemId), poItemId: poItem?.id ?? null, poItem, qty, unitPrice, lineAmt: qty * unitPrice };
    });

    const netAmt = lines.reduce((sum, l) => sum + l.lineAmt, 0);
    const discountAmt = num(body.discountAmt);
    if (discountAmt < 0 || discountAmt > netAmt) throw badRequest('Discount must be between 0 and the invoice net amount');
    const afterDiscount = netAmt - discountAmt;
    const vatRate = body.vatRate === undefined || body.vatRate === '' ? null : num(body.vatRate);
    const vatAmt = body.vatAmt !== undefined && body.vatAmt !== ''
        ? num(body.vatAmt)
        : (vatRate ? afterDiscount * vatRate / 100 : 0);

    const extras = (Array.isArray(body.extras) ? body.extras : []).map((x, i) => {
        const costType = String(x.costType || '').trim();
        if (!SUPPLIER_INVOICE_EXTRA_TYPES.includes(costType)) throw badRequest(`Extra cost ${i + 1}: choose a type`);
        const amount = num(x.amount, NaN);
        if (!(amount > 0)) throw badRequest(`Extra cost ${i + 1}: amount must be more than 0`);
        const xCurrency = String(x.currency || 'JOD').trim().toUpperCase() || 'JOD';
        const xRate = xCurrency === 'JOD' ? 1 : (xCurrency === currency ? exchangeRate : num(x.exchangeRate, NaN));
        if (!(xRate > 0)) throw badRequest(`Extra cost ${i + 1}: exchange rate to JOD is required`);
        return {
            costType, description: x.description ? String(x.description).trim() : null,
            vendorId: x.vendorId ? Number(x.vendorId) : null,
            amount, currency: xCurrency, exchangeRate: xRate, amountJod: round(amount * xRate),
        };
    });
    const extraCostsJod = extras.reduce((sum, x) => sum + x.amountJod, 0);

    // Spread by value: a line's share of the discount and of the extras is
    // its share of netAmt (equal shares if every price is 0).
    for (const l of lines) {
        const share = netAmt > 0 ? l.lineAmt / netAmt : 1 / lines.length;
        const lineCostJod = (l.lineAmt - discountAmt * share) * exchangeRate + extraCostsJod * share;
        l.landedUnitCost = round(lineCostJod / l.qty);
    }

    // Price check against the PO and what was actually received.
    const warnings = [];
    const receiptWhere = body.goodsReceiptId ? { goodsReceiptId: Number(body.goodsReceiptId) } : null;
    let receivedByPoItem = new Map();
    let receivedByItem = new Map();
    const grIds = receiptWhere
        ? [Number(body.goodsReceiptId)]
        : (await MatWhGoodsReceipt.findAll({ where: { purchaseOrderId: po.id }, attributes: ['id'] })).map((g) => g.id);
    if (grIds.length > 0) {
        const grItems = await MatWhGoodsReceiptItem.findAll({ where: { goodsReceiptId: grIds } });
        for (const g of grItems) {
            if (g.poItemId) receivedByPoItem.set(g.poItemId, (receivedByPoItem.get(g.poItemId) || 0) + Number(g.qtyAccepted));
            receivedByItem.set(g.itemId, (receivedByItem.get(g.itemId) || 0) + Number(g.qtyAccepted));
        }
    }
    for (const l of lines) {
        if (!l.poItem) {
            warnings.push({ itemId: l.itemId, poItemId: null, type: 'not_on_po', message: 'Item is not on the purchase order (or matches more than one PO line)' });
            continue;
        }
        const poPrice = Number(l.poItem.unitPrice);
        if (poPrice > 0 && Math.abs(l.unitPrice - poPrice) > 0.0001) {
            const pct = ((l.unitPrice - poPrice) / poPrice) * 100;
            warnings.push({ itemId: l.itemId, poItemId: l.poItemId, type: 'price', message: `Price ${l.unitPrice} vs PO ${poPrice} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` });
        }
        if (l.qty > Number(l.poItem.qtyOrdered) + 0.0001) {
            warnings.push({ itemId: l.itemId, poItemId: l.poItemId, type: 'qty_ordered', message: `Invoiced ${l.qty} but ordered ${l.poItem.qtyOrdered}` });
        }
        const received = receivedByPoItem.get(l.poItemId) ?? receivedByItem.get(l.itemId) ?? 0;
        if (Math.abs(l.qty - received) > 0.0001) {
            warnings.push({ itemId: l.itemId, poItemId: l.poItemId, type: 'qty_received', message: `Invoiced ${l.qty} but received ${received}` });
        }
    }

    return {
        currency, exchangeRate,
        netAmt: round(netAmt), discountAmt: round(discountAmt),
        vatRate, vatAmt: round(vatAmt), grossAmt: round(afterDiscount + vatAmt),
        extraCostsJod: round(extraCostsJod), landedTotalJod: round(afterDiscount * exchangeRate + extraCostsJod),
        lines: lines.map(({ poItem, ...l }) => l), // eslint-disable-line no-unused-vars
        extras, warnings,
    };
}

// What can be billed on a coating request: one row per job that went out,
// with the item, the colour it came back as, the bars (received, else
// sent) and the variant's weight per bar when known.
export async function coatingInvoiceCandidates(requestNo) {
    const jobs = await MatWhExternalProcessing.findAll({
        where: { requestNo, status: ['sent', 'received'] }, order: [['id', 'ASC']],
    });
    if (jobs.length === 0) return [];
    const items = await MatWhItem.findAll({ where: { id: [...new Set(jobs.map((j) => j.itemId))] } });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const variants = await MatWhItemVariant.findAll({ where: { itemId: [...new Set(jobs.map((j) => j.itemId))] } });
    const weightFor = (job) => {
        const color = normalizeColor(job.targetColor);
        const v = variants.find((x) => x.itemId === job.itemId
            && normalizeColor(x.color) === color
            && (job.lengthMm == null || Number(x.lengthMm) === Number(job.lengthMm)));
        return v?.unitWeight ? Number(v.unitWeight) : null;
    };
    return jobs.map((j) => {
        const qty = Number(j.qtyReceived) > 0 ? Number(j.qtyReceived) : Number(j.qtySent);
        const unitWeight = weightFor(j);
        return {
            jobId: j.id, itemId: j.itemId,
            itemCode: itemById.get(j.itemId)?.itemCode ?? null, itemName: itemById.get(j.itemId)?.itemName ?? null,
            color: j.targetColor, lengthMm: j.lengthMm, status: j.status,
            qtySent: Number(j.qtySent), qtyReceived: j.qtyReceived == null ? null : Number(j.qtyReceived),
            qty, unitWeight, weightKg: unitWeight ? round(qty * unitWeight, 3) : null,
        };
    });
}

// Validates Mix's per-kg lines against the request's jobs and prices them.
// Returns { lines, paintingCost, warnings } -- warnings when the billed
// bars differ from what came back.
export async function computeCoatingInvoiceLines(requestNo, rawLines) {
    const candidates = await coatingInvoiceCandidates(requestNo);
    const byJob = new Map(candidates.map((c) => [c.jobId, c]));
    const lines = rawLines.map((l, i) => {
        const job = byJob.get(Number(l.jobId));
        if (!job) throw badRequest(`Line ${i + 1}: not an item sent on this coating request`);
        const qty = num(l.qty, job.qty);
        const weightKg = num(l.weightKg, job.weightKg ?? NaN);
        const pricePerKg = num(l.pricePerKg, NaN);
        if (!(qty > 0) || !(weightKg > 0) || !(pricePerKg >= 0)) {
            throw badRequest(`Line ${i + 1} (${job.itemCode}): qty, weight (kg) and price per kg are required`);
        }
        return {
            jobId: job.jobId, itemId: job.itemId, color: job.color, lengthMm: job.lengthMm,
            qty, weightKg: round(weightKg, 3), pricePerKg, lineAmt: round(weightKg * pricePerKg, 3),
        };
    });
    const warnings = [];
    for (const l of lines) {
        const job = byJob.get(l.jobId);
        const back = job.qtyReceived ?? 0;
        if (Math.abs(l.qty - back) > 0.0001) {
            warnings.push({ jobId: l.jobId, itemCode: job.itemCode, message: `Billed ${l.qty} bars but ${back} came back` });
        }
    }
    return { lines, paintingCost: round(lines.reduce((sum, l) => sum + l.lineAmt, 0), 3), warnings };
}

// Shared by the warehouse's and Mix's own invoice entry: with per-kg lines
// the painting cost is their sum (a typed paintingCost is ignored), saved
// with the lines in one transaction.
export async function createCoatingInvoice(requestNo, values, rawLines) {
    const hasLines = Array.isArray(rawLines) && rawLines.length > 0;
    const calc = hasLines ? await computeCoatingInvoiceLines(requestNo, rawLines) : null;
    return sequelizeUtf8.transaction(async (t) => {
        const row = await MatWhCoatingInvoice.create({
            ...values, requestNo, ...(calc ? { paintingCost: calc.paintingCost } : {}),
        }, { transaction: t });
        if (calc) {
            for (const line of calc.lines) {
                await MatWhCoatingInvoiceItem.create({ coatingInvoiceId: row.id, ...line }, { transaction: t });
            }
        }
        return { ...row.toJSON(), lines: calc?.lines ?? [], warnings: calc?.warnings ?? [] };
    });
}

// Each invoice with its own lines attached.
export async function withCoatingInvoiceLines(invoices) {
    if (invoices.length === 0) return [];
    const lines = await MatWhCoatingInvoiceItem.findAll({
        where: { coatingInvoiceId: invoices.map((i) => i.id) }, order: [['id', 'ASC']],
    });
    return invoices.map((inv) => ({ ...inv.toJSON(), lines: lines.filter((l) => l.coatingInvoiceId === inv.id) }));
}
