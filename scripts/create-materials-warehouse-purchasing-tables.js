// ------------------------------------------------------
// backend/scripts/create-materials-warehouse-purchasing-tables.js
// ------------------------------------------------------
// Creates the 7 WH.2 tables (Purchasing: PO -> goods receipt -> supplier
// invoice, plus the QC-category detail table deferred out of WH.1).
// Uses each model's own .sync() (create-if-missing, non-destructive), same
// pattern as create-materials-warehouse-tables.js. Safe to re-run.
import { MatWhPurchaseOrder } from "../models/MatWhPurchaseOrder.js";
import { MatWhPurchaseOrderItem } from "../models/MatWhPurchaseOrderItem.js";
import { MatWhGoodsReceipt } from "../models/MatWhGoodsReceipt.js";
import { MatWhGoodsReceiptItem } from "../models/MatWhGoodsReceiptItem.js";
import { MatWhQcResult } from "../models/MatWhQcResult.js";
import { MatWhSupplierInvoice } from "../models/MatWhSupplierInvoice.js";
import { MatWhSupplierInvoiceItem } from "../models/MatWhSupplierInvoiceItem.js";

const run = async () => {
    try {
        await MatWhPurchaseOrder.sync();
        console.log("✅ matWhPurchaseOrders ready");
        await MatWhPurchaseOrderItem.sync();
        console.log("✅ matWhPurchaseOrderItems ready");
        await MatWhGoodsReceipt.sync();
        console.log("✅ matWhGoodsReceipts ready");
        await MatWhGoodsReceiptItem.sync();
        console.log("✅ matWhGoodsReceiptItems ready");
        await MatWhQcResult.sync();
        console.log("✅ matWhQcResults ready");
        await MatWhSupplierInvoice.sync();
        console.log("✅ matWhSupplierInvoices ready");
        await MatWhSupplierInvoiceItem.sync();
        console.log("✅ matWhSupplierInvoiceItems ready");
        process.exit(0);
    } catch (err) {
        console.error("❌ Failed to create materials warehouse purchasing tables:", err);
        process.exit(1);
    }
};

run();
