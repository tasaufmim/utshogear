/**
 * Daily costing (expenses) — categories + entries.
 *
 * Money in integer cents, `date` is the business date string so every report
 * range is a plain string comparison. Entries are owner-created; corrections
 * are audited (before/after) rather than silent.
 */
import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

const ExpenseCategorySchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    createdAt: { type: String, default: null },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'expense_categories' }
);

export const ExpenseCategory = model('ExpenseCategory', ExpenseCategorySchema);

const ExpenseSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    date: { type: String, required: true }, // business date YYYY-MM-DD
    createdAt: { type: String, required: true }, // ISO UTC
    categoryId: { type: String, required: true },
    categoryName: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['cash', 'bkash', 'nagad', 'card'], default: 'cash' },
    note: { type: String, default: '' },
    userId: { type: String, default: null },
    userName: { type: String, default: '' },
    syncedAt: { type: String, default: null },
  },
  { timestamps: false, collection: 'expenses' }
);

ExpenseSchema.index({ date: 1 });
ExpenseSchema.index({ categoryId: 1, date: -1 });

export const Expense = model('Expense', ExpenseSchema);
