/**
 * Supply side: suppliers, purchase orders (goods received), supplier payments
 * (accounts payable) and the notification queue.
 *
 * Ledger rule: purchases/supplier_payments are append-only. Mistakes are
 * corrected with reversing rows, never edits. `dueBalance` on suppliers is a
 * cache reconcilable from sales/purchases/payments.
 */
import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

/* ------------------------------- supplier ------------------------------- */
const SupplierSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    note: { type: String, default: '' },

    dueBalance: { type: Number, default: 0 }, // cents we owe them
    totalPurchased: { type: Number, default: 0 }, // cents
    purchaseCount: { type: Number, default: 0 },
    lastPurchaseAt: { type: String, default: null },

    createdAt: { type: String, default: null },
    updatedAt: { type: String, default: null },
    deletedAt: { type: String, default: null },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'suppliers' }
);

export const Supplier = model('Supplier', SupplierSchema);

/* ------------------------------ purchase ------------------------------- */
const PurchaseLineSchema = new Schema(
  {
    productId: { type: String, required: true },
    sku: String,
    name: String,
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true }, // cents, invoice price
    extraAlloc: { type: Number, default: 0 }, // freight etc. allocated to this line
    unitCost: { type: Number, required: true }, // cents, LANDED (unitPrice + extraAlloc)
    lineTotal: { type: Number, required: true }, // unitPrice * qty
  },
  { _id: false }
);

const PurchaseSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    ref: { type: String, unique: true }, // PUR-2026-000001
    supplierId: { type: String, default: null },
    supplierName: { type: String, default: 'Walk-in supplier' },
    supplierInvoice: { type: String, default: '' },

    createdAt: { type: String, required: true },
    date: { type: String, required: true }, // business date

    lines: { type: [PurchaseLineSchema], default: [] },
    subtotalCents: { type: Number, required: true },
    extraCostCents: { type: Number, default: 0 }, // freight / duty, allocated by line value
    grandTotalCents: { type: Number, required: true },

    paidCents: { type: Number, default: 0 },
    dueCents: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['cash', 'bkash', 'nagad', 'card', 'credit'], default: 'cash' },

    note: { type: String, default: '' },
    userId: { type: String, default: null },
    userName: { type: String, default: '' },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'purchases' }
);

PurchaseRefIndex(PurchaseSchema);
function PurchaseRefIndex(schema) {
  schema.index({ supplierId: 1, createdAt: -1 });
  schema.index({ createdAt: -1 });
}

export const Purchase = model('Purchase', PurchaseSchema);

/* --------------------------- supplier payment --------------------------- */
const SupplierPaymentSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    supplierId: { type: String, required: true },
    amountCents: { type: Number, required: true },
    method: { type: String, enum: ['cash', 'bkash', 'nagad', 'card'], default: 'cash' },
    note: { type: String, default: '' },
    refPurchaseUuid: { type: String, default: null },
    createdAt: { type: String, required: true },
    userId: { type: String, default: null },
    userName: { type: String, default: '' },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'supplier_payments' }
);

SupplierPaymentSchema.index({ supplierId: 1, createdAt: -1 });

export const SupplierPayment = model('SupplierPayment', SupplierPaymentSchema);

/* ---------------------------- notifications ---------------------------- */
/**
 * Outbound message queue. Rows are created by triggers (low stock, debt due,
 * daily summary) and consumed by the SMS sender when a provider is configured.
 * Until then the UI simply reads the queue — fully offline.
 */
const NotificationSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    kind: { type: String, enum: ['low_stock', 'due_reminder', 'daily_summary', 'info'], required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    toPhone: { type: String, default: '' }, // customer phone for reminders
    refType: { type: String, default: null }, // 'product' | 'customer' | 'day'
    refId: { type: String, default: null },
    status: { type: String, enum: ['queued', 'sent', 'read', 'skipped'], default: 'queued' },
    createdAt: { type: String, required: true },
    readAt: { type: String, default: null },
    sentAt: { type: String, default: null },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'notifications' }
);

NotificationSchema.index({ status: 1, createdAt: 1 });
NotificationSchema.index({ kind: 1, refId: 1 });

export const Notification = model('Notification', NotificationSchema);
