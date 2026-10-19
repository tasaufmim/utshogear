/**
 * Customer + due (debt) ledger foundation.
 *
 * `dueBalance` is a CACHE: truth = SUM(completed sales with due) − SUM(payments).
 * scripts/reconcile-stock.mjs also checks this the same way it checks stock.
 * Payments are append-only — a mistake is corrected with a reversing row.
 */
import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

const CustomerSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    bikes: { type: String, default: '', trim: true }, // "Pulsar 150, red" — shop notes
    note: { type: String, default: '' },

    dueBalance: { type: Number, default: 0 }, // cents owed to the shop
    totalSpent: { type: Number, default: 0 }, // cents, completed sales
    visitCount: { type: Number, default: 0 },
    lastVisitAt: { type: String, default: null },

    createdAt: { type: String, default: null }, // ISO UTC
    updatedAt: { type: String, default: null },
    deletedAt: { type: String, default: null },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'customers' }
);

export const Customer = model('Customer', CustomerSchema);

const PaymentSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    customerId: { type: String, required: true },
    amountCents: { type: Number, required: true }, // positive = payment received
    method: { type: String, enum: ['cash', 'bkash', 'nagad', 'card'], default: 'cash' },
    note: { type: String, default: '' },
    // optional link when the customer pays a specific receipt
    refSaleUuid: { type: String, default: null },
    type: { type: String, enum: ['payment', 'adjustment'], default: 'payment' },
    createdAt: { type: String, required: true },
    userId: { type: String, default: null },
    userName: { type: String, default: '' },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'customer_payments' }
);

PaymentSchema.index({ customerId: 1, createdAt: -1 });

export const CustomerPayment = model('CustomerPayment', PaymentSchema);
