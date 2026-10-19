import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, stripFor } from '../middleware/auth.js';
import { Product, Category, buildSearchText } from '../models/Catalog.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, notFound, validation } from '../lib/errors.js';
import { normalizeBarcode, renderPng } from '../services/barcodeService.js';
import { marginPct, targetPrice } from '../lib/money.js';
import { getSettings } from '../models/Settings.js';

export const productsRouter = Router();
productsRouter.use(requireAuth);

const write = requireRole('owner');

/* All money fields are INTEGER CENTS (the client converts with toCents). */
const cents = z.number().int().min(0).max(1_000_000_000);

const productSchema = z.object({
  name: z.string().min(1).max(120),
  sku: z.string().max(40).optional(),
  barcode: z.string().max(40).optional(),
  barcodeType: z.enum(['CODE128', 'EAN13']).default('CODE128'),
  categoryId: z.string().min(1),
  brandId: z.string().nullable().optional(),
  productModel: z.string().max(60).optional(),
  bikeModelIds: z.array(z.string()).max(60).optional(),
  universal: z.boolean().optional(),
  size: z.string().max(30).optional(),
  color: z.string().max(30).optional(),
  variantGroup: z.string().max(60).optional(),
  avgCost: cents.optional(),
  lastPurchasePrice: cents.optional(),
  floorPrice: cents.optional(),
  sellPrice: cents,
  mrp: cents.nullable().optional(),
  defaultMarginPct: z.number().min(0).max(1000).nullable().optional(),
  warrantyDays: z.number().int().min(0).max(3650).optional(),
  reorderLevel: z.number().int().min(0).max(99999).optional(),
  active: z.boolean().optional(),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSku = (raw, name, size) => {
  const base = String(raw || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (base) return base;
  const slug =
    String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'ITEM';
  const sizePart = size ? `-${String(size).toUpperCase().replace(/\s/g, '')}` : '';
  return `${slug}${sizePart}`;
};

async function assertUnique({ sku, barcode, excludeUuid }) {
  const scope = excludeUuid ? { uuid: { $ne: excludeUuid } } : {};
  if (sku) {
    const dup = await Product.findOne({ sku, ...scope }).select('uuid name').lean();
    if (dup) throw conflict(`SKU "${sku}" is already used by "${dup.name}"`, { field: 'sku' });
  }
  if (barcode) {
    const dup = await Product.findOne({ barcode, ...scope }).select('uuid name').lean();
    if (dup) throw conflict(`Barcode "${barcode}" already belongs to "${dup.name}"`, { field: 'barcode' });
  }
}

async function assertNoDuplicateProduct(body, excludeUuid) {
  const fingerprint = buildSearchText(body.name, body.size, body.color);
  const candidates = await Product.find({
    deletedAt: null,
    ...(excludeUuid ? { uuid: { $ne: excludeUuid } } : {}),
    name: { $regex: new RegExp(`^${escapeRe(String(body.name).trim())}$`, 'i') },
  })
    .select('uuid size color name')
    .lean();
  const clash = candidates.find((p) => buildSearchText(p.name, p.size, p.color) === fingerprint);
  if (clash) {
    throw conflict(`A product named "${clash.name}"${clash.size ? ` (${clash.size})` : ''} already exists`, {
      field: 'name',
    });
  }
}

/* ------------------------------------------------------------------ *
 * SEARCH — ranked: exact barcode → exact SKU → prefix → substring →
 * raw name. Local indexes only, so it works fully offline.
 * ------------------------------------------------------------------ */
productsRouter.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const filters = { deletedAt: null, active: true };

    if (req.query.categoryId) filters.categoryId = String(req.query.categoryId);
    if (req.query.brandId) filters.brandId = String(req.query.brandId);
    if (req.query.inStock === '1') filters.stock = { $gt: 0 };
    if (req.query.fits) filters.$or = [{ universal: true }, { bikeModelIds: String(req.query.fits) }];

    const results = [];
    const seen = new Set();
    const push = (docs) => {
      for (const d of docs) {
        if (!seen.has(d.uuid)) {
          seen.add(d.uuid);
          results.push(d);
        }
      }
    };

    if (!q) {
      push(await Product.find(filters).sort({ name: 1 }).limit(limit).lean());
    } else {
      const norm = buildSearchText(q);
      const upper = q.toUpperCase();
      const prefix = (s) => ({ $gte: s, $lt: s + '\uffff' });

      push(await Product.find({ ...filters, barcode: q }).limit(limit).lean());
      if (results.length < limit)
        push(await Product.find({ ...filters, sku: upper }).limit(limit - results.length).lean());
      if (results.length < limit)
        push(
          await Product.find({ ...filters, searchText: prefix(norm) })
            .limit(limit - results.length)
            .lean()
        );
      if (results.length < limit)
        push(
          await Product.find({ ...filters, searchText: new RegExp(escapeRe(norm), 'i') })
            .limit(limit - results.length)
            .lean()
        );
      if (results.length < limit)
        push(
          await Product.find({ ...filters, name: new RegExp(escapeRe(q).replace(/[\s-]+/g, '[\\s-]*'), 'i') })
            .limit(limit - results.length)
            .lean()
        );
    }

    res.json(stripFor(req.user.role, { data: results.slice(0, limit) }));
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- LIST --------------------------------- */
productsRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filters = { deletedAt: null };
    const prefix = (s) => ({ $gte: s, $lt: s + '\uffff' });

    if (req.query.q) {
      const norm = buildSearchText(String(req.query.q));
      filters.$or = [
        { searchText: prefix(norm) },
        { searchText: new RegExp(escapeRe(norm), 'i') },
        { barcode: String(req.query.q) },
      ];
    }
    if (req.query.categoryId) filters.categoryId = String(req.query.categoryId);
    if (req.query.brandId) filters.brandId = String(req.query.brandId);
    if (req.query.inStock === '1') filters.stock = { $gt: 0 };
    if (req.query.lowStock === '1') filters.$expr = { $lte: ['$stock', { $ifNull: ['$reorderLevel', 0] }] };
    if (req.query.active === '0') filters.active = false;

    const sort =
      req.query.sort === 'stock' ? { stock: 1 } : req.query.sort === 'name' ? { name: 1 } : { updatedAt: -1 };

    const [items, total] = await Promise.all([
      Product.find(filters).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(filters),
    ]);

    res.json(stripFor(req.user.role, { data: items, meta: { total, page, limit } }));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- READ -------------------------------- */
productsRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await Product.findOne({
      $or: [{ uuid: req.params.id }, { sku: String(req.params.id).toUpperCase() }],
      deletedAt: null,
    }).lean();
    if (!doc) throw notFound('Product not found');
    res.json(stripFor(req.user.role, { data: doc }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ Barcode PNG ---------------------------- */
productsRouter.get('/:id/barcode.png', async (req, res, next) => {
  try {
    const doc = await Product.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!doc) throw notFound('Product not found');
    if (!doc.barcode) throw notFound('This product has no barcode yet');

    const png = await renderPng(doc.barcode, doc.barcodeType, {
      height: Number(req.query.h) || 40,
      scale: Number(req.query.scale) || 3,
    });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=3600').send(png);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- CREATE -------------------------------- */
productsRouter.post('/', write, async (req, res, next) => {
  try {
    const body = productSchema.parse(req.body);

    const category = await Category.findOne({ uuid: body.categoryId, deletedAt: null }).lean();
    if (!category) throw validation('Unknown category', { field: 'categoryId' });

    const sku = normalizeSku(body.sku, body.name, body.size);

    let barcode = body.barcode?.trim() || '';
    if (!barcode && body.barcodeType === 'EAN13') {
      throw validation('EAN-13 requires an explicit 12 or 13 digit barcode', { field: 'barcode' });
    }
    const normalized = normalizeBarcode(barcode, body.barcodeType, sku);
    if (normalized.error) throw validation(normalized.error, { field: 'barcode' });
    barcode = normalized.value;

    await assertUnique({ sku, barcode });
    await assertNoDuplicateProduct(body);

    const doc = await Product.create({
      ...body,
      sku,
      barcode,
      avgCost: body.avgCost ?? 0,
      lastPurchasePrice: body.lastPurchasePrice ?? 0,
      floorPrice: body.floorPrice ?? 0,
      mrp: body.mrp ?? null,
    });

    await AuditRepo.log({
      action: 'product.create',
      entity: 'product',
      entityId: doc.uuid,
      after: priceSnapshot(doc),
      actor: req.user,
      meta: { name: doc.name, sku: doc.sku, barcode: doc.barcode },
    });

    res.status(201).json(stripFor(req.user.role, { data: doc }));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- UPDATE -------------------------------- */
productsRouter.patch('/:id', write, async (req, res, next) => {
  try {
    const before = await Product.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!before) throw notFound('Product not found');

    const patch = productSchema.partial().parse(req.body);
    delete patch.sku; // SKU is immutable once it is printed on a label

    if (patch.categoryId) {
      const category = await Category.findOne({ uuid: patch.categoryId, deletedAt: null }).lean();
      if (!category) throw validation('Unknown category', { field: 'categoryId' });
    }

    if (patch.barcode !== undefined) {
      const normalized = normalizeBarcode(patch.barcode, patch.barcodeType || before.barcodeType, before.sku);
      if (normalized.error) throw validation(normalized.error, { field: 'barcode' });
      await assertUnique({ barcode: normalized.value, excludeUuid: before.uuid });
      patch.barcode = normalized.value;
    }
    if (patch.name !== undefined || patch.size !== undefined || patch.color !== undefined) {
      await assertNoDuplicateProduct(
        {
          name: patch.name ?? before.name,
          size: patch.size ?? before.size,
          color: patch.color ?? before.color,
        },
        before.uuid
      );
    }

    const after = await Product.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: patch },
      { new: true, runValidators: true, timestamps: true }
    );

    // rebuild normalized search text (the pre-validate hook only fires on .save())
    after.searchText = buildSearchText(
      after.name,
      after.sku,
      after.barcode,
      after.productModel,
      after.size,
      after.color
    );
    await after.save();

    const priceKeys = ['avgCost', 'lastPurchasePrice', 'floorPrice', 'sellPrice', 'mrp', 'defaultMarginPct'];
    const changedPrices = priceKeys.filter((k) => before[k] !== after[k]);

    await AuditRepo.log({
      action: changedPrices.length ? 'product.price_change' : 'product.update',
      entity: 'product',
      entityId: before.uuid,
      before: pickChanged(before, patch),
      after: pickChanged(after, patch),
      actor: req.user,
      meta: changedPrices.length ? { prices: changedPrices } : { keys: Object.keys(patch) },
    });

    res.json(stripFor(req.user.role, { data: after }));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- DELETE -------------------------------- */
productsRouter.delete('/:id', write, async (req, res, next) => {
  try {
    const doc = await Product.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!doc) throw notFound('Product not found');
    if (doc.stock !== 0) {
      throw conflict(
        `Cannot delete — stock on hand is ${doc.stock}. Adjust it to zero first so the ledger stays complete.`,
        { stock: doc.stock }
      );
    }
    await Product.updateOne({ uuid: req.params.id }, { $set: { deletedAt: new Date().toISOString() } });
    await AuditRepo.log({
      action: 'product.delete',
      entity: 'product',
      entityId: doc.uuid,
      before: priceSnapshot(doc),
      actor: req.user,
      meta: { name: doc.name, sku: doc.sku },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- four-price view (owner only) ------------------- */
productsRouter.get('/:id/pricing', requireRole('owner'), async (req, res, next) => {
  try {
    const doc = await Product.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!doc) throw notFound('Product not found');
    const settings = await getSettings();
    const pct = doc.defaultMarginPct ?? settings.defaultMarginPct;
    res.json({
      data: {
        purchasePrice: doc.avgCost,
        lastPurchasePrice: doc.lastPurchasePrice,
        floorPrice: doc.floorPrice,
        marginPrice: targetPrice(doc.avgCost, pct),
        marginPct: pct,
        sellPrice: doc.sellPrice,
        mrp: doc.mrp ?? doc.sellPrice,
        marginAmt: doc.sellPrice - doc.avgCost,
        marginPctActual: marginPct(doc.avgCost, doc.sellPrice),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- helpers -------------------------------- */
function priceSnapshot(p) {
  return {
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    categoryId: p.categoryId,
    avgCost: p.avgCost,
    lastPurchasePrice: p.lastPurchasePrice,
    floorPrice: p.floorPrice,
    sellPrice: p.sellPrice,
    mrp: p.mrp,
    active: p.active,
  };
}

function pickChanged(doc, patch) {
  const out = {};
  for (const key of Object.keys(patch)) out[key] = doc?.[key];
  return out;
}
