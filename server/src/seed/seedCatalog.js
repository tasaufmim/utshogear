/**
 * Phase 2 seed — categories, brands, bike models and a realistic starter
 * catalog for a motorcycle-accessories shop. Idempotent: re-running skips
 * anything that already exists.
 *
 * Opening stock is written BOTH to `products.stock` and as `stock_moves`
 * (type OPENING) so the reconcile check always passes.
 */
import { Category, Brand, BikeModel, Product } from '../models/Catalog.js';
import { coll } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso, businessDate } from '../lib/dates.js';

const CATEGORIES = [
  'Helmets',
  'Lights & Electrical',
  'Horns',
  'Locks & Security',
  'Oils & Lubricants',
  'Filters',
  'Brake Parts',
  'Body & Mirrors',
  'Riding Gear',
  'Batteries',
  'Tools & Accessories',
];

const BRANDS = [
  'Studds', 'Steelbird', 'LS2', 'Honda', 'Yamaha', 'Bajaj', 'TVS', 'Royal Enfield',
  'Motul', 'Castrol', 'Yamalube', 'Lumax', 'Depo', 'Link', 'Boss', 'RCB', 'ND',
  'QH', 'Osram', 'Bosch', 'NGK', 'UNO Minda',
];

const BIKES = [
  ['Bajaj', 'Pulsar 150'], ['Bajaj', 'Pulsar 180'], ['Bajaj', 'Pulsar NS160'],
  ['Bajaj', 'Platina 110'], ['Bajaj', 'Discover 125'], ['Bajaj', 'CT100'],
  ['Honda', 'Honda Shine'], ['Honda', 'Honda Livo'], ['Honda', 'Honda SP125'],
  ['Honda', 'Honda CB Hornet 160R'], ['Honda', 'Honda Dio'], ['Honda', 'Honda Activa'],
  ['Yamaha', 'Yamaha FZ-S'], ['Yamaha', 'Yamaha FZ 25'], ['Yamaha', 'Yamaha R15'],
  ['Yamaha', 'Yamaha Saluto'], ['Yamaha', 'Yamaha Ray ZR'],
  ['TVS', 'Apache RTR 160'], ['TVS', 'Apache RTR 200'], ['TVS', 'TVS Metro'],
  ['TVS', 'TVS Radeon'], ['TVS', 'TVS Ntorq'],
  ['Royal Enfield', 'Bullet 350'], ['Royal Enfield', 'Classic 350'],
  ['Royal Enfield', 'Himalayan'], ['Royal Enfield', 'Meteor 350'],
  ['Suzuki', 'Gixxer SF'], ['Suzuki', 'Gixxer 150'], ['Suzuki', 'Suzuki Access'],
  ['Hero', 'Hero Splendor'], ['Hero', 'Hero Glamour'], ['Hero', 'Hero HF Deluxe'],
  ['Hero', 'Hero Passion Pro'], ['Hero', 'Hero Maestro'],
  ['Kawasaki', 'Ninja 300'], ['KTM', 'Duke 200'], ['KTM', 'RC 200'],
  ['Runner', 'Runner Knight Rider'], ['Lifan', 'Lifan KPR 150'], ['Hover', 'Hover Cyber'],
];

/** price helper: taka → integer cents */
const c = (taka) => Math.round(taka * 100);

// name, category, brand, cost, sell, mrp, [options]
const PRODUCTS = [
  ['Studds Thunder Full Face Helmet', 'Helmets', 'Studds', 1800, 2500, 2700, { size: 'L', variantGroup: 'Studds Thunder', stock: 8, universal: true }],
  ['Studds Thunder Full Face Helmet', 'Helmets', 'Studds', 1800, 2500, 2700, { size: 'M', variantGroup: 'Studds Thunder', stock: 5, universal: true }],
  ['Studds Thunder Full Face Helmet', 'Helmets', 'Studds', 1800, 2500, 2700, { size: 'XL', variantGroup: 'Studds Thunder', stock: 3, universal: true }],
  ['Steelbird SA2 Half Face Helmet', 'Helmets', 'Steelbird', 1200, 1650, 1750, { size: 'M', variantGroup: 'Steelbird SA2', stock: 6, universal: true }],
  ['Steelbird SA2 Half Face Helmet', 'Helmets', 'Steelbird', 1200, 1650, 1750, { size: 'L', variantGroup: 'Steelbird SA2', stock: 4, universal: true }],
  ['Motul 7100 4T 10W40 1L', 'Oils & Lubricants', 'Motul', 1150, 1450, 1500, { stock: 12, universal: true }],
  ['Motul 3100 4T 15W40 1L', 'Oils & Lubricants', 'Motul', 750, 990, 1050, { stock: 15, universal: true }],
  ['Yamalube Engine Oil 1L', 'Oils & Lubricants', 'Yamalube', 480, 620, 660, { stock: 20, universal: true }],
  ['Chain Lube 500ml', 'Oils & Lubricants', 'Motul', 420, 620, 680, { stock: 10, universal: true }],
  ['PIAA LED H4 Headlight Bulb', 'Lights & Electrical', 'Depo', 650, 950, 1050, { warranty: 90, stock: 9, universal: true }],
  ['Osram H4 60/55W Halogen Bulb', 'Lights & Electrical', 'Osram', 250, 400, 450, { warranty: 30, stock: 14, universal: true }],
  ['Lumax LED Indicator Set', 'Lights & Electrical', 'Lumax', 700, 1100, 1200, { warranty: 90, stock: 7, universal: true }],
  ['Bosch Horn 12V', 'Horns', 'Bosch', 450, 680, 750, { warranty: 90, stock: 11, universal: true }],
  ['QH Snail Horn', 'Horns', 'QH', 300, 480, 520, { stock: 16, universal: true }],
  ['Link Helmet Lock', 'Locks & Security', 'Link', 180, 280, 320, { stock: 22, universal: true }],
  ['Boss Disc Lock', 'Locks & Security', 'Boss', 550, 850, 950, { stock: 8, universal: true }],
  ['Oil Filter — Pulsar 150', 'Filters', 'Bajaj', 120, 200, 230, { model: 'Pulsar 150', bikes: ['Pulsar 150'], stock: 25 }],
  ['Air Filter — Honda Shine', 'Filters', 'Honda', 150, 240, 270, { model: 'Shine', bikes: ['Honda Shine'], stock: 18 }],
  ['Brake Pad Set — Apache RTR 160', 'Brake Parts', 'TVS', 220, 380, 420, { model: 'RTR 160', bikes: ['Apache RTR 160'], stock: 13 }],
  ['Rear View Mirror Set', 'Body & Mirrors', 'UNO Minda', 280, 450, 500, { stock: 12, universal: true }],
  ['Bike Cover — Universal', 'Body & Mirrors', 'Link', 350, 580, 650, { stock: 17, universal: true }],
  ['Riding Gloves', 'Riding Gear', 'RCB', 450, 750, 850, { size: 'L', variantGroup: 'RCB Gloves', stock: 6, universal: true }],
  ['Riding Gloves', 'Riding Gear', 'RCB', 450, 750, 850, { size: 'M', variantGroup: 'RCB Gloves', stock: 5, universal: true }],
  ['12V 5Ah Battery', 'Batteries', 'Bosch', 1300, 1650, 1800, { warranty: 180, stock: 6, universal: true }],
  ['Spark Plug — NGK CPR9EA-9', 'Tools & Accessories', 'NGK', 90, 150, 170, { stock: 30, universal: true }],
];

export async function seedCatalog(log = console.log) {
  // ---------- categories ----------
  const catByName = {};
  for (const [i, name] of CATEGORIES.entries()) {
    let doc = await Category.findOne({ searchText: name.toLowerCase(), deletedAt: null });
    if (!doc) doc = await Category.create({ name, sortOrder: i, searchText: name.toLowerCase() });
    catByName[name] = doc.uuid;
  }
  log(`  · categories: ${CATEGORIES.length}`);

  // ---------- brands ----------
  const brandByName = {};
  for (const name of BRANDS) {
    let doc = await Brand.findOne({ name });
    if (!doc) doc = await Brand.create({ name });
    brandByName[name] = doc.uuid;
  }
  log(`  · brands: ${BRANDS.length}`);

  // ---------- bike models ----------
  const bikeByName = {};
  for (const [make, name] of BIKES) {
    let doc = await BikeModel.findOne({ name });
    if (!doc) doc = await BikeModel.create({ name, make });
    bikeByName[name] = doc.uuid;
  }
  log(`  · bike models: ${BIKES.length}`);

  // ---------- products ----------
  let created = 0;
  for (const [name, cat, brand, cost, sell, mrp, opts = {}] of PRODUCTS) {
    const size = opts.size || '';
    const fingerprint = `${name}|${size}`.toLowerCase();

    const existing = await Product.findOne({
      name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      size,
      deletedAt: null,
    });
    if (existing) continue;

    const sku = makeSku(name, size);
    // derive the Code128 value NOW so the unique barcode index never sees ''
    const { normalizeBarcode } = await import('../services/barcodeService.js');
    const norm = normalizeBarcode('', 'CODE128', sku);

    const doc = await Product.create({
      name,
      sku,
      barcode: norm.value,
      categoryId: catByName[cat],
      brandId: brandByName[brand] || null,
      productModel: opts.model || '',
      bikeModelIds: (opts.bikes || []).map((b) => bikeByName[b]).filter(Boolean),
      universal: !!opts.universal,
      size,
      variantGroup: opts.variantGroup || '',
      avgCost: c(cost),
      lastPurchasePrice: c(cost),
      floorPrice: c(Math.round(cost * 0.95)),
      sellPrice: c(sell),
      mrp: c(mrp),
      warrantyDays: opts.warranty || 0,
      reorderLevel: 3,
      stock: 0,
      searchText: '',
    });

    // opening stock (ledger + cache, so reconcile passes)
    const qty = opts.stock || 0;
    if (qty > 0) {
      await Product.updateOne({ uuid: doc.uuid }, { $set: { stock: qty } });
      await coll('stock_moves').insertOne({
        uuid: uuid(),
        productId: doc.uuid,
        type: 'OPENING',
        qty,
        unitCost: c(cost),
        refType: 'SEED',
        refId: 'seed',
        note: 'Opening stock (seed)',
        date: nowIso(),
        userId: null,
        createdAt: nowIso(),
      });
    }
    created++;
  }
  log(`  + products created: ${created} (${PRODUCTS.length - created} already present)`);
  return { categories: CATEGORIES.length, brands: BRANDS.length, bikes: BIKES.length, products: created };
}

function makeSku(name, size) {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  const sizePart = size ? `-${size.toUpperCase().replace(/\s/g, '')}` : '';
  return `${slug}${sizePart}`;
}
