import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, stripFor } from '../middleware/auth.js';
import { Product } from '../models/Catalog.js';
import { coll } from '../config/db.js';
import { getSettings } from '../models/Settings.js';
import { adjustStock, reconcile, lowStockList, queueLowStockNotifications } from '../services/stockService.js';
import { notFound } from '../lib/errors.js';
import { businessDayStartUtc, businessDayEndUtc } from '../lib/dates.js';

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);

const owner = requireRole('owner');

/* --------------------------- stock ledger (moves) -------------------------- */
inventoryRouter.get('/moves', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filter = {};
    if (req.query.productId) filter.productId = String(req.query.productId);
    if (req.query.type) filter.type = String(req.query.type);
    if (req.query.from) filter.createdAt = { ...filter.createdAt, $gte: businessDayStartUtc(String(req.query.from).slice(0, 10)) };
    if (req.query.to) filter.createdAt = { ...filter.createdAt, $lt: businessDayEndUtc(String(req.query.to).slice(0, 10)) };

    const [items, total] = await Promise.all([
      coll('stock_moves').find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
      coll('stock_moves').countDocuments(filter),
    ]);

    // join product names in one query (no N+1)
    const ids = [...new Set(items.map((m) => m.productId))];
    const products = await Product.find({ uuid: { $in: ids } }).select('uuid name sku stock').lean();
    const byId = Object.fromEntries(products.map((p) => [p.uuid, p]));

    res.json({
      data: items.map((m) => ({ ...m, product: byId[m.productId] ?? null })),
      meta: { total, limit },
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- ADJUST --------------------------------- */
inventoryRouter.post('/adjust', owner, async (req, res, next) => {
  try {
    const body = z
      .object({
        productId: z.string().min(1),
        delta: z.number().int().min(-99999).max(99999),
        reason: z.string().min(3).max(200),
        unitCost: z.number().int().min(0).optional(),
      })
      .parse(req.body);

    const result = await adjustStock({
      ...body,
      actor: { userId: req.user.userId, name: req.user.name, role: req.user.role },
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- LOW STOCK -------------------------------- */
inventoryRouter.get('/low-stock', async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const items = await lowStockList(settings.lowStockDefault ?? 3);
    res.json({ data: items, meta: { defaultLevel: settings.lowStockDefault ?? 3 } });
  } catch (err) {
    next(err);
  }
});

/** Queue digest rows (owner) — feeds the SMS queue when a provider exists. */
inventoryRouter.post('/low-stock/scan', owner, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const result = await queueLowStockNotifications(settings.lowStockDefault ?? 3);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- RECONCILE -------------------------------- */
inventoryRouter.get('/reconcile', owner, async (_req, res, next) => {
  try {
    res.json({ data: await reconcile() });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- SUMMARY (KPI) ----------------------------- */
inventoryRouter.get('/summary', async (req, res, next) => {
  try {
    const products = await Product.find({ deletedAt: null, active: true })
      .select('stock avgCost reorderLevel')
      .lean();

    const settings = await getSettings();
    let stockValue = 0;
    let units = 0;
    let low = 0;
    for (const p of products) {
      stockValue += p.stock * (p.avgCost || 0);
      units += p.stock;
      if (p.stock <= (p.reorderLevel || settings.lowStockDefault || 3)) low++;
    }
    res.json(
      stripFor(req.user.role, {
        data: { products: products.length, units, lowStock: low, stockValueCents: stockValue },
      })
    );
  } catch (err) {
    next(err);
  }
});
