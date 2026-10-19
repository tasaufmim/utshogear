import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, stripFor } from '../middleware/auth.js';
import { Return } from '../models/Return.js';
import { createReturn } from '../services/returnService.js';
import { resolveOwnerOverride } from './sales.js';
import { notFound, unauthorized } from '../lib/errors.js';

export const returnsRouter = Router();
returnsRouter.use(requireAuth);

const cents = z.number().int().min(0).max(1_000_000_000);

const returnLineSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(9999),
  reason: z.string().max(200).optional(),
  restock: z.boolean().optional(),
});

const exchangeLineSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(9999),
  unitPrice: cents,
  lineDiscount: z
    .object({ type: z.enum(['pct', 'amt']), val: z.number().min(0).max(1_000_000) })
    .nullish(),
});

const bodySchema = z.object({
  saleUuid: z.string().min(1),
  lines: z.array(returnLineSchema).min(1).max(100),
  method: z.enum(['cash', 'original', 'due_adjust']).default('cash'),
  exchangeLines: z.array(exchangeLineSchema).min(1).max(200).optional(),
  extraPaidCents: cents.optional(),
  exchangeClientTxnId: z.string().max(64).optional(),
});

/* ------------------------------ CREATE RETURN ----------------------------- */
returnsRouter.post('/', async (req, res, next) => {
  try {
    const body = bodySchema.parse(req.body);

    // Owner PIN is consulted only when a header is present or the user IS the
    // owner; the service raises RETURN_WINDOW for out-of-window returns by
    // cashiers, which the client turns into a PIN prompt + retry.
    let ownerIdVerified = req.user.role === 'owner';
    if (!ownerIdVerified && req.get('x-owner-pin')) {
      ownerIdVerified = await resolveOwnerOverride(req);
      if (!ownerIdVerified) throw unauthorized('Incorrect owner PIN');
    }

    const result = await createReturn(
      { ...body, ownerIdVerified },
      { userId: req.user.userId, name: req.user.name, role: req.user.role }
    );

    res.status(201).json(
      stripFor(req.user.role, {
        data: { return: result.returnDoc, sale: result.sale },
      })
    );
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- HISTORY --------------------------------- */
returnsRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 30, 200);

    const filter = {};
    if (req.query.from) filter.date = { ...filter.date, $gte: String(req.query.from).slice(0, 10) };
    if (req.query.to) filter.date = { ...filter.date, $lte: String(req.query.to).slice(0, 10) };
    if (req.query.q) {
      const rx = new RegExp(
        String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );
      filter.$or = [{ returnNo: rx }, { receiptNo: rx }, { customerName: rx }];
    }

    const [items, total] = await Promise.all([
      Return.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Return.countDocuments(filter),
    ]);
    res.json(stripFor(req.user.role, { data: items, meta: { total, page, limit } }));
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- DETAIL --------------------------------- */
returnsRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await Return.findOne({
      $or: [{ uuid: req.params.id }, { returnNo: String(req.params.id).toUpperCase() }],
    }).lean();
    if (!doc) throw notFound('Return not found');
    res.json(stripFor(req.user.role, { data: doc }));
  } catch (err) {
    next(err);
  }
});
