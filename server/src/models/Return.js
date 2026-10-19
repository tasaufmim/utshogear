/**
 * Customer returns & exchanges.
 *
 * A return points at the original sale, refunds at the price actually paid,
 * and restocks only lines flagged `restock` (damaged goods come back into
 * inventory as-is or are written off by the owner later). An exchange is a
 * return whose `exchangeSaleUuid` links to the replacement sale — both are
 * written in ONE transaction, so a crash can never leave half an exchange.
 */
import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

const ReturnLineSchema = new Schema(
  {
    productId: { type: String, required: true },
    sku: String,
    name: String,
    size: String,
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true }, // cents refunded per unit (price actually paid)
    reason: { type: String, default: '' },
    restock: { type: Boolean, default: true },
  },
  { _id: false }
);

const ReturnSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    returnNo: { type: String, required: true, unique: true }, // UGRR-2026-000001
    saleUuid: { type: String, required: true },
    receiptNo: { type: String, required: true },

    date: { type: String, required: true }, // business date
    createdAt: { type: String, required: true }, // ISO UTC

    lines: { type: [ReturnLineSchema], default: [] },
    refundCents: { type: Number, required: true },
    method: { type: String, enum: ['cash', 'original', 'due_adjust'], default: 'cash' },

    isExchange: { type: Boolean, default: false },
    exchangeSaleUuid: { type: String, default: null },

    customerId: { type: String, default: null },
    customerName: { type: String, default: 'Walk-in' },

    userId: { type: String, default: null },
    userName: { type: String, default: '' },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'returns' }
);

ReturnSchema.index({ saleUuid: 1 });
ReturnSchema.index({ createdAt: -1 });
ReturnSchema.index({ customerId: 1, createdAt: -1 });

export const Return = model('Return', ReturnSchema);
