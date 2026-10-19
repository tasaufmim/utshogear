import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, stripFor } from '../middleware/auth.js';
import { Sale, Park } from '../models/Sale.js';
import { Product } from '../models/Catalog.js';
import { checkout, voidSale, parkCart } from '../services/posService.js';
import { verifyOwnerPin } from '../services/authService.js';
import { forbidden, notFound, validation, unauthorized } from '../lib/errors.js';
import { nowIso, businessDayStartUtc, businessDayEndUtc } from '../lib/dates.js';
import { AuditRepo } from '../repos/AuditRepo.js';

export const salesRouter = Router();
salesRouter.use(requireAuth);

const cents = z.number().int().min(0).max(1_000_000_000);

const lineSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(9999),
  unitPrice: cents,
  lineDiscount: z
    .object({ type: z.enum(['pct', 'amt']), val: z.number().min(0).max(1_000_000) })
    .nullish(),
});

const checkoutSchema = z.object({
  clientTxnId: z.string().max(64).optional(),
  lines: z.array(lineSchema).min(1).max(200),
  orderDiscount: z
    .object({ type: z.enum(['pct', 'amt']), val: z.number().min(0).max(1_000_000) })
    .nullish(),
  payment: z.object({
    method: z.enum(['cash', 'bkash', 'nagad', 'card', 'due']),
    paidCents: cents.optional(),
  }),
  customerId: z.string().nullable().optional(),
  customerName: z.string().max(80).optional(),
  customerPhone: z.string().max(30).optional(),
  note: z.string().max(500).optional(),
  parkUuid: z.string().max(64).optional(),
});

/**
 * Owner PIN gate shared by checkout & void.
 * - owner acting as self: passes immediately
 * - otherwise the x-owner-pin header must verify
 */
export async function resolveOwnerOverride(req) {
  if (req.user.role === 'owner') return true;
  const pin = req.get('x-owner-pin');
  if (!pin) return false;
  const ok = await verifyOwnerPin(pin);
  if (!ok) throw unauthorized('Incorrect owner PIN');
  return true;
}

/* ------------------------------- CHECKOUT ------------------------------- */
salesRouter.post('/', async (req, res, next) => {
  try {
    const body = checkoutSchema.parse(req.body);

    // Only pay the PIN cost when the cart actually needs an override.
    let ownerIdVerified = req.user.role === 'owner';
    if (!ownerIdVerified) {
      const needsOverride = await cartNeedsOverride(body);
      if (needsOverride) ownerIdVerified = await resolveOwnerOverride(req);
    }

    const result = await checkout(
      { ...body, ownerIdVerified },
      {
        userId: req.user.userId,
        name: req.user.name,
        role: req.user.role,
      }
    );

    res.status(result.duplicate ? 200 : 201).json({
      duplicate: result.duplicate,
      ...stripFor(req.user.role, { data: result.sale }),
    });
  } catch (err) {
    next(err);
  }
});

/** Cheap pre-check so the PIN modal only appears when it must. */
async function cartNeedsOverride(body) {
  const ids = body.lines.map((l) => l.productId);
  const products = await Product.find({ uuid: { $in: ids } }).select('uuid floorPrice stock').lean();
  const byId = Object.fromEntries(products.map((p) => [p.uuid, p]));

  for (const l of body.lines) {
    const p = byId[l.productId];
    if (p && p.floorPrice > 0 && l.unitPrice < p.floorPrice) return true;
  }

  const afterLines = body.lines.reduce(
    (sum, l) => sum + l.unitPrice * l.qty - (l.lineDiscount?.type ? disc(l.lineDiscount, l.unitPrice * l.qty) : 0),
    0
  );
  const od = body.orderDiscount;
  if (od && od.val > 0) {
    const amt = od.type === 'pct' ? Math.round((afterLines * Math.min(od.val, 100)) / 100) : od.val;
    if (afterLines && amt / afterLines > 0.1) return true;
  }
  return false;
}
const disc = (d, base) =>
  d.type === 'pct' ? Math.round((base * Math.min(Math.max(d.val, 0), 100)) / 100) : Math.min(d.val, base);

/* -------------------------------- HISTORY ------------------------------- */
salesRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const filters = {};
    if (req.query.from) filters.createdAt = { ...filters.createdAt, $gte: businessDayStartUtc(String(req.query.from).slice(0, 10)) };
    if (req.query.to) filters.createdAt = { ...filters.createdAt, $lt: businessDayEndUtc(String(req.query.to).slice(0, 10)) };
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.customerId) filters.customerId = String(req.query.customerId);
    if (req.query.method) filters['payment.method'] = String(req.query.method);
    if (req.query.q) {
      const q = String(req.query.q);
      filters.$or = [
        { receiptNo: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        { customerName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        { 'lines.sku': q.toUpperCase() },
      ];
    }

    const [items, total] = await Promise.all([
      Sale.find(filters).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Sale.countDocuments(filters),
    ]);

    res.json(stripFor(req.user.role, { data: items, meta: { total, page, limit } }));
  } catch (err) {
    next(err);
  }
});

/** Daily Z-lite summary used by the history header (not the full Z-report). */
salesRouter.get('/today', async (req, res, next) => {
  try {
    const start = businessDayStartUtc(new Date().toISOString().slice(0, 10));
    const end = businessDayEndUtc(new Date().toISOString().slice(0, 10));
    const match = { createdAt: { $gte: start, $lt: end }, status: 'completed' };
    const [agg] = await Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          total: { $sum: '$totalCents' },
          due: { $sum: '$payment.dueCents' },
          cogs: { $sum: '$cogsCents' },
        },
      },
    ]);
    res.json(
      stripFor(req.user.role, {
        data: {
          count: agg?.count ?? 0,
          totalCents: agg?.total ?? 0,
          dueCents: agg?.due ?? 0,
          cogsCents: agg?.cogs ?? 0,
        },
      })
    );
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- DETAIL ------------------------------- */
salesRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await Sale.findOne({
      $or: [{ uuid: req.params.id }, { receiptNo: String(req.params.id).toUpperCase() }],
    }).lean();
    if (!doc) throw notFound('Sale not found');
    res.json(stripFor(req.user.role, { data: doc }));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- VOID -------------------------------- */
salesRouter.post('/:id/void', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      const ok = await resolveOwnerOverride(req);
      if (!ok) {
        throw forbidden('Voiding a sale requires the owner PIN', 'OWNER_PIN_REQUIRED');
      }
    }
    const reason = String(req.body?.reason || '').slice(0, 300);
    const result = await voidSale({
      saleUuid: req.params.id,
      reason,
      actor: { userId: req.user.userId, name: req.user.name, role: req.user.role },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  PARKS — savable / recallable carts
 * ===================================================================== */
export const parksRouter = Router();
parksRouter.use(requireAuth);

parksRouter.get('/', async (_req, res, next) => {
  try {
    const items = await Park.find({ status: 'held' }).sort({ updatedAt: -1 }).limit(100).lean();
    // expand line details so recall is instant
    const ids = [...new Set(items.flatMap((p) => p.lines.map((l) => l.productId)))];
    const products = await Product.find({ uuid: { $in: ids }, deletedAt: null })
      .select('uuid name sku barcode size stock sellPrice')
      .lean();
    const byId = Object.fromEntries(products.map((p) => [p.uuid, p]));
    const expanded = items.map((p) => ({
      ...p,
      lines: p.lines.map((l) => ({ ...l, product: byId[l.productId] ?? null })),
      totalCents: p.lines.reduce((s, l) => s + l.unitPrice * l.qty - (l.lineDiscountCents || 0), 0),
    }));
    res.json({ data: expanded });
  } catch (err) {
    next(err);
  }
});

parksRouter.post('/', async (req, res, next) => {
  try {
    const body = z
      .object({
        parkUuid: z.string().max(64).optional(),
        name: z.string().max(60).optional(),
        note: z.string().max(300).optional(),
        customerId: z.string().nullable().optional(),
        lines: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().min(1),
              unitPrice: cents,
              lineDiscountCents: cents.optional(),
            })
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);

    const doc = await parkCart(
      body,
      { userId: req.user.userId, name: req.user.name, role: req.user.role }
    );
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

parksRouter.post('/:id/discard', async (req, res, next) => {
  try {
    const r = await Park.updateOne(
      { uuid: req.params.id, status: 'held' },
      { $set: { status: 'discarded', updatedAt: nowIso() } }
    );
    if (!r.matchedCount) throw notFound('Parked cart not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
