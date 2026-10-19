/**
 * POS records — sale, parked (held) cart.
 *
 * Timestamps are APP-GENERATED ISO-8601 UTC STRINGS (portability rule), so
 * every report range query is a plain string comparison — no DB date parsing,
 * works identically on local Mongo and Atlas.
 */
import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

/* ------------------------------- sale line ------------------------------- */
const LineSchema = new Schema(
  {
    uuid: { type: String, default: () => uuid() },
    productId: { type: String, required: true },
    sku: String,
    barcode: String,
    name: String,
    size: String,
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true }, // cents, what customer pays
    mrpAtSale: { type: Number, default: 0 },
    lineDiscountCents: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 }, // cost snapshot at sale time (owner-only)
    cogs: { type: Number, default: 0 }, // unitCost * qty (owner-only)
    lineTotal: { type: Number, required: true }, // after line discount
    warrantyDays: { type: Number, default: 0 },
  },
  { _id: false }
);

/* --------------------------------- sale ---------------------------------- */
const SaleSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    receiptNo: { type: String, required: true, unique: true },
    clientTxnId: { type: String, unique: true, sparse: true }, // idempotency key

    date: { type: String, required: true }, // business date 'YYYY-MM-DD'
    createdAt: { type: String, required: true }, // ISO UTC
    updatedAt: { type: String, required: true },

    lines: { type: [LineSchema], default: [] },

    subtotalCents: { type: Number, required: true },
    orderDiscountCents: { type: Number, default: 0 },
    orderDiscountType: { type: String, enum: ['pct', 'amt', null], default: null },
    totalCents: { type: Number, required: true },
    cogsCents: { type: Number, default: 0 }, // owner-only, stripped for cashiers
    profitCents: { type: Number, default: 0 },

    payment: {
      method: { type: String, enum: ['cash', 'bkash', 'nagad', 'card', 'due'], default: 'cash' },
      paidCents: { type: Number, default: 0 },
      changeCents: { type: Number, default: 0 },
      dueCents: { type: Number, default: 0 },
    },

    customerId: { type: String, default: null },
    customerName: { type: String, default: 'Walk-in' },
    customerPhone: { type: String, default: '' },

    salesmanId: { type: String, required: true },
    salesmanName: { type: String, required: true },

    status: { type: String, enum: ['completed', 'voided'], default: 'completed' },
    voidedAt: { type: String, default: null },
    voidReason: { type: String, default: null },
    voidedBy: { type: String, default: null },

    note: { type: String, default: '' },
    syncedAt: { type: String, default: null }, // Phase 10 push watermark
  },
  { timestamps: false, collection: 'sales' }
);

SaleSchema.index({ createdAt: -1 });
SaleSchema.index({ customerId: 1, createdAt: -1 });
SaleSchema.index({ status: 1, createdAt: -1 });
SaleSchema.index({ date: 1 });

export const Sale = model('Sale', SaleSchema);

/* --------------------------- parked / held cart -------------------------- */
const ParkLineSchema = new Schema(
  {
    productId: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true }, // cents
    lineDiscountCents: { type: Number, default: 0 },
  },
  { _id: false }
);

const ParkSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, default: '' },
    lines: { type: [ParkLineSchema], default: [] },
    orderDiscountCents: { type: Number, default: 0 },
    customerId: { type: String, default: null },
    note: { type: String, default: '' },
    status: { type: String, enum: ['held', 'recalled', 'checked_out', 'discarded'], default: 'held' },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, default: null },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'parks' }
);

export const Park = model('Park', ParkSchema);
