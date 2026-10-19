import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    pinHash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'cashier'], required: true },
    active: { type: Boolean, default: true },
    mustChangePin: { type: Boolean, default: false },

    // brute-force protection
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: String, default: null }, // ISO UTC

    // last successful sign-in (shown in System → Users; ISO UTC string like
    // the other ledger timestamps — NOT a Date, per the sync convention)
    lastLoginAt: { type: String, default: null },

    // for future sync (Phase 10)
    deletedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'users' }
);

export const User = model('User', UserSchema);

const SettingsSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: 'settings-singleton' },

    shopName: { type: String, default: 'UTSHO GEAR' },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    logo: { type: String, default: null },

    currency: { type: String, default: 'BDT' },
    receiptPrefix: { type: String, default: 'UGR' },
    returnPrefix: { type: String, default: 'UGRR' },
    receiptYear: { type: Number, default: new Date().getUTCFullYear() },
    receiptSeq: { type: Number, default: 0 },
    returnSeq: { type: Number, default: 0 },

    defaultMarginPct: { type: Number, default: 25 },
    lowStockDefault: { type: Number, default: 3 },
    returnWindowDays: { type: Number, default: 7 },
    suggestCoverDays: { type: Number, default: 14 },
    footerNote: { type: String, default: 'Thank you — ride safe!' },

    labelPrinter: {
      name: { type: String, default: 'Label Printer' },
      paperWidth: { type: String, default: '38mm' },
      template: { type: String, default: '38x25' },
      marginTop: { type: Number, default: 0 },
      marginLeft: { type: Number, default: 0 },
      showMrp: { type: Boolean, default: true },
    },
    receiptPrinter: {
      name: { type: String, default: 'Receipt Printer' },
      paperWidth: { type: String, default: '80mm' },
      autoPrint: { type: Boolean, default: true },
    },

    smsConfig: {
      provider: { type: String, default: 'null' },
      apiKey: { type: String, default: '' },
      senderId: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
    },

    dailySummaryEnabled: { type: Boolean, default: true },
    lowStockDigestEnabled: { type: Boolean, default: true },
    updatedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'settings' }
);

export const Settings = model('Settings', SettingsSchema);

/** First-run guard: returns the singleton settings doc, creating it if absent. */
export async function getSettings(session) {
  const opts = session ? { session } : {};
  let doc = await Settings.findOne({ uuid: 'settings-singleton' }).lean();
  if (!doc) {
    const [created] = await Settings.create([{ uuid: 'settings-singleton' }], opts);
    doc = created.toObject();
  }
  return doc;
}
