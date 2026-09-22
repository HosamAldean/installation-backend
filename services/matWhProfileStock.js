// backend/services/matWhProfileStock.js
// Shared helpers for the Materials Warehouse Profile Store sub-module --
// on-hand balance and barcode/location resolution, used by
// routes/materialsWarehouseProfileStore.js. Mirrors matWhLedger.js's role
// for the generic side, but computed directly from the profile-store
// transaction tables rather than a separate unified ledger table -- each of
// those tables (receipts/shipments/returns/coatingBatches/transfers) is
// itself already a flat, single-purpose ledger of one movement type.
import { MatWhProfileStock } from '../models/MatWhProfileStock.js';
import { MatWhProfileCatalog } from '../models/MatWhProfileCatalog.js';
import { MatWhProfileReceipt } from '../models/MatWhProfileReceipt.js';
import { MatWhProfileShipment } from '../models/MatWhProfileShipment.js';
import { MatWhProfileReturn } from '../models/MatWhProfileReturn.js';
import { MatWhProfileCoatingBatch } from '../models/MatWhProfileCoatingBatch.js';
import { MatWhProfileTransfer } from '../models/MatWhProfileTransfer.js';
import { MatWhProfileReservation } from '../models/MatWhProfileReservation.js';

// Physical on-hand for one profileStock row: received - shipped + returned
// - sentToCoating + transferredIn - transferredOut. Material sent to
// coating is a real outflow the moment it's sent (the coated result comes
// back under a *different* profileStockId, its own target-color barcode --
// see receiveCoatingBatch below) -- same modeling Stock House's own
// computeOnHand used, after its documented QtyAvl/QtyOut corrections.
export async function getPhysicalBalance(profileStockId) {
    const [received, shipped, returned, sentToCoating, transferIn, transferOut] = await Promise.all([
        MatWhProfileReceipt.sum('qtyReceived', { where: { profileStockId } }),
        MatWhProfileShipment.sum('qty', { where: { profileStockId } }),
        MatWhProfileReturn.sum('qty', { where: { profileStockId } }),
        MatWhProfileCoatingBatch.sum('qtySent', { where: { profileStockId } }),
        MatWhProfileTransfer.sum('qty', { where: { profileStockId, direction: 'in' } }),
        MatWhProfileTransfer.sum('qty', { where: { profileStockId, direction: 'out' } }),
    ]);
    return (received || 0) - (shipped || 0) + (returned || 0) - (sentToCoating || 0)
        + (transferIn || 0) - (transferOut || 0);
}

// Available-to-reserve = physical balance - currently active reservations
// for the same profileStock row.
export async function getAvailableToReserve(profileStockId) {
    const physical = await getPhysicalBalance(profileStockId);
    const reserved = await MatWhProfileReservation.sum('qty', {
        where: { profileStockId, status: 'active' },
    });
    return physical - (reserved || 0);
}

// Resolves an existing profileStock row for a known
// profileCatalogId+color+lengthMm+storeId combination, or creates one when
// `createIfMissing` is true and a barcode is supplied -- mirrors Stock
// House's resolveComputerNo, but as a real row instead of a derived lookup.
export async function resolveProfileStock({ profileCatalogId, color, lengthMm, storeId, barcode, zone, locationColumn, locationRow }, { createIfMissing = false } = {}) {
    const existing = await MatWhProfileStock.findOne({
        where: { profileCatalogId, color, lengthMm, storeId },
    });
    if (existing) return existing;
    if (!createIfMissing) return null;
    if (!barcode) return null;
    return MatWhProfileStock.create({
        profileCatalogId, color, lengthMm, storeId, barcode,
        zone: zone || null, locationColumn: locationColumn || null, locationRow: locationRow || null,
    });
}

// Application-level join, matching this codebase's existing matWh*
// convention (plain FK integer columns, no Sequelize associations) -- the
// caller gets both the stock row and its catalog row (profileNo/name/photo)
// in one call since barcode lookups almost always need both.
export async function findProfileStockByBarcode(barcode, storeId) {
    const where = { barcode };
    if (storeId) where.storeId = storeId;
    const stock = await MatWhProfileStock.findOne({ where });
    if (!stock) return null;
    const catalog = await MatWhProfileCatalog.findByPk(stock.profileCatalogId);
    return { stock, catalog };
}
