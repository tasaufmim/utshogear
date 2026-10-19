import mongoose from 'mongoose';
import { uuid } from '../lib/ids.js';

const { Schema, model } = mongoose;

/* ------------------------------------------------------------------ *
 *  Shared: normalized search text.
 *  "USB-C Charger 65W" → "usbc charger 65w"
 *  Strips - _ / ( ) . , so all common spellings collide into one key.
 * ------------------------------------------------------------------ */
export function buildSearchText(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(' ')
    .normalize('NFC') // Bangla correctness
    .toLowerCase()
    .replace(/[-_\/().,:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------- Category ------------------------------- */
const CategorySchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, trim: true },
    parentId: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    searchText: { type: String, default: '' },
    deletedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'categories' }
);
CategorySchema.pre('save', function () {
  this.searchText = buildSearchText(this.name);
});
export const Category = model('Category', CategorySchema);

/* -------------------------------- Brand -------------------------------- */
const BrandSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, unique: true, trim: true },
    deletedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'brands' }
);
export const Brand = model('Brand', BrandSchema);

/* ------------------------------ Bike model ----------------------------- */
const BikeModelSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },
    name: { type: String, required: true, unique: true, trim: true },
    make: { type: String, default: 'Other', trim: true },
    active: { type: Boolean, default: true },
    deletedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'bike_models' }
);
export const BikeModel = model('BikeModel', BikeModelSchema);

/* -------------------------------- Product ------------------------------- */
const ProductSchema = new Schema(
  {
    uuid: { type: String, required: true, unique: true, default: () => uuid() },

    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true, trim: true },
    barcode: { type: String, unique: true, sparse: true, trim: true },
    barcodeType: { type: String, enum: ['CODE128', 'EAN13'], default: 'CODE128' },

    categoryId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    productModel: { type: String, default: '', trim: true },

    // fitment (many-to-many) + universal flag
    bikeModelIds: { type: [String], default: [] },
    universal: { type: Boolean, default: false },

    // size = separate product (own SKU/barcode); variantGroup groups them in POS
    size: { type: String, default: '' },
    color: { type: String, default: '' },
    variantGroup: { type: String, default: '' },

    unit: { type: String, default: 'pcs' },

    /* ---- four prices, INTEGER CENTS ---- */
    avgCost: { type: Number, default: 0 }, // ① purchase price (weighted avg)
    lastPurchasePrice: { type: Number, default: 0 },
    floorPrice: { type: Number, default: 0 }, // lowest acceptable in a bargain
    sellPrice: { type: Number, required: true }, // ③ what the customer pays
    mrp: { type: Number, default: null }, // ④ printed MRP (nullable)
    defaultMarginPct: { type: Number, default: null }, // per-product override
    // ② margin price is COMPUTED: avgCost × (1 + pct/100)

    warrantyDays: { type: Number, default: 0 },
    reorderLevel: { type: Number, default: 0 },

    images: { type: [String], default: [] },
    stock: { type: Number, default: 0 }, // cache; SUM(stock_moves) is truth

    searchText: { type: String, default: '' },
    active: { type: Boolean, default: true },
    deletedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'products' }
);

ProductSchema.pre('validate', function (next) {
  this.searchText = buildSearchText(
    this.name,
    this.sku,
    this.barcode,
    this.productModel,
    this.size,
    this.color
  );
  next();
});

export const Product = model('Product', ProductSchema);

/** Prices arrive from the client in taka; convert once, centrally. */
export function centsFromTaka(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}
