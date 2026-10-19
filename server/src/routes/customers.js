import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, stripFor } from '../middleware/auth.js';
import { Customer, CustomerPayment } from '../models/Customer.js';
import { Sale } from '../models/Sale.js';
import { coll, withTxn } from '../config/db.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, notFound, validation, badRequest } from '../lib/errors.js';
import { nowIso, businessDayStartUtc, businessDayEndUtc, businessDate } from '../lib/dates.js';
import { uuid } from '../lib/ids.js';

export const customersRouter = Router();
customersRouter.use(requireAuth);

const write = requireRole('owner');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const profileSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(20).optional(),
  address: z.string().max(160).optional(),
  bikes: z.string().max(120).optional(),
  note: z.string().max(400).optional(),
});

/* ------------------------------- SEARCH/LIST ------------------------------ *
 * ?q= phone/name fragment · ?hasDue=1 · ?sort=due|recent|name
 * --------------------------------------------------------------------------- */
customersRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filters = { deletedAt: null };

    if (req.query.q) {
      const rx = new RegExp(escapeRe(String(req.query.q)), 'i');
      filters.$or = [{ phone: rx }, { name: rx }, { address: rx }, { bikes: rx }];
    }
    if (req.query.hasDue === '1') filters.dueBalance = { $gt: 0 };
    if (req.query.uuid) filters.uuid = String(req.query.uuid);

    const sort =
      req.query.sort === 'due'
        ? { dueBalance: -1, updatedAt: -1 }
        : req.query.sort === 'name'
          ? { name: 1 }
          : { updatedAt: -1 };

    const items = await Customer.find(filters).sort(sort).limit(limit).lean();
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- CREATE -------------------------------- */
customersRouter.post('/', async (req, res, next) => {
  try {
    const body = profileSchema.parse(req.body);
    const phone = (body.phone || '').trim();

    if (phone) {
      const dup = await Customer.findOne({ phone, deletedAt: null }).lean();
      if (dup) throw conflict(`Phone already belongs to "${dup.name}"`, { field: 'phone' });
    }

    const at = nowIso();
    const doc = await Customer.create({ ...body, phone, createdAt: at, updatedAt: at });

    await AuditRepo.log({
      action: 'customer.create',
      entity: 'customer',
      entityId: doc.uuid,
      after: { name: doc.name, phone: doc.phone },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- READ ---------------------------------- */
customersRouter.get('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findOne({
      $or: [{ uuid: req.params.id }, { phone: req.params.id }],
      deletedAt: null,
    }).lean();
    if (!customer) throw notFound('Customer not found');

    const [recentSales, payments] = await Promise.all([
      Sale.find({ customerId: customer.uuid, status: 'completed' })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      CustomerPayment.find({ customerId: customer.uuid }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    res.json(
      stripFor(req.user.role, {
        data: { ...customer, recentSales, payments },
      })
    );
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- UPDATE --------------------------------- */
customersRouter.patch('/:id', async (req, res, next) => {
  try {
    const before = await Customer.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!before) throw notFound('Customer not found');

    const patch = profileSchema.partial().parse(req.body);
    if (patch.phone !== undefined) {
      patch.phone = String(patch.phone).trim();
      if (patch.phone) {
        const dup = await Customer.findOne({
          phone: patch.phone,
          uuid: { $ne: before.uuid },
          deletedAt: null,
        }).lean();
        if (dup) throw conflict(`Phone already belongs to "${dup.name}"`, { field: 'phone' });
      }
    }

    const after = await Customer.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: { ...patch, updatedAt: nowIso() } },
      { new: true }
    ).lean();

    const keys = Object.keys(patch);
    await AuditRepo.log({
      action: 'customer.update',
      entity: 'customer',
      entityId: before.uuid,
      before: pick(before, keys),
      after: pick(after, keys),
      actor: req.user,
      meta: { keys },
    });
    res.json({ data: after });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- DUE LEDGER (debt view) ----------------------- */
customersRouter.get('/:id/due-ledger', async (req, res, next) => {
  try {
    const customer = await Customer.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!customer) throw notFound('Customer not found');

    const [sales, payments] = await Promise.all([
      Sale.find({
        customerId: customer.uuid,
        status: 'completed',
        'payment.dueCents': { $gt: 0 },
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      CustomerPayment.find({ customerId: customer.uuid }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);

    res.json(
      stripFor(req.user.role, {
        data: {
          dueBalance: customer.dueBalance,
          sales: sales.map((s) => ({
            uuid: s.uuid,
            receiptNo: s.receiptNo,
            createdAt: s.createdAt,
            date: s.date,
            totalCents: s.totalCents,
            dueCents: s.payment.dueCents,
            paymentMethod: s.payment.method,
            customerName: s.customerName,
          })),
          payments,
        },
      })
    );
  } catch (err) {
    next(err);
  }
});

/* -------------------------- PAYMENT AGAINST DEBT -------------------------- */
const paySchema = z.object({
  amountCents: z.number().int().min(1).max(1_000_000_000),
  method: z.enum(['cash', 'bkash', 'nagad', 'card']).default('cash'),
  note: z.string().max(200).optional(),
  refSaleUuid: z.string().max(64).nullable().optional(),
});

customersRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const body = paySchema.parse(req.body);
    const actor = { userId: req.user.userId, name: req.user.name, role: req.user.role };

    const payment = await withTxn(async (session) => {
      const customer = await Customer.findOne({ uuid: req.params.id, deletedAt: null }).session(session);
      if (!customer) throw notFound('Customer not found');
      if (body.amountCents > customer.dueBalance) {
        throw badRequest(
          `Payment exceeds due balance (due ৳${(customer.dueBalance / 100).toFixed(2)})`,
          { dueBalance: customer.dueBalance }
        );
      }

      const at = nowIso();
      const doc = {
        uuid: uuid(),
        customerId: customer.uuid,
        amountCents: body.amountCents,
        method: body.method,
        note: body.note || '',
        refSaleUuid: body.refSaleUuid || null,
        type: 'payment',
        createdAt: at,
        userId: actor.userId,
        userName: actor.name,
        syncedAt: null,
      };
      await CustomerPayment.create([doc], { session });

      await Customer.updateOne(
        { uuid: customer.uuid },
        { $inc: { dueBalance: -body.amountCents }, $set: { updatedAt: at } },
        { session }
      );

      await AuditRepo.log({
        action: 'customer.payment',
        entity: 'customer',
        entityId: customer.uuid,
        after: { amountCents: body.amountCents, method: body.method, dueAfter: customer.dueBalance - body.amountCents },
        actor,
        meta: { note: body.note || '', refSaleUuid: body.refSaleUuid || null },
        session,
      });
      return doc;
    });

    res.status(201).json({ data: payment });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- CUSTOMER-WISE ANALYTICS ------------------------ */
customersRouter.get('/:id/analytics', async (req, res, next) => {
  try {
    const customer = await Customer.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!customer) throw notFound('Customer not found');

    const from = req.query.from ? businessDayStartUtc(String(req.query.from).slice(0, 10)) : undefined;
    const to = req.query.to ? businessDayEndUtc(String(req.query.to).slice(0, 10)) : undefined;

    const match = { customerId: customer.uuid, status: 'completed' };
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = from;
      if (to) match.createdAt.$lt = to;
    }

    const [totals, byMonth, topProducts] = await Promise.all([
      Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            visits: { $sum: 1 },
            total: { $sum: '$totalCents' },
            due: { $sum: '$payment.dueCents' },
            cogs: { $sum: '$cogsCents' },
          },
        },
      ]),
      Sale.aggregate([
        { $match: match },
        { $group: { _id: '$date', total: { $sum: '$totalCents' }, count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
        { $limit: 12 },
      ]),
      Sale.aggregate([
        { $match: match },
        { $unwind: '$lines' },
        {
          $group: {
            _id: '$lines.name',
            qty: { $sum: '$lines.qty' },
            spent: { $sum: '$lines.lineTotal' },
          },
        },
        { $sort: { spent: -1 } },
        { $limit: 10 },
      ]),
    ]);

    res.json(
      stripFor(req.user.role, {
        data: {
          customer,
          totals: {
            visits: totals[0]?.visits ?? 0,
            totalCents: totals[0]?.total ?? 0,
            dueCents: totals[0]?.due ?? 0,
            cogsCents: totals[0]?.cogs ?? 0,
          },
          byDay: byMonth,
          topProducts,
        },
      })
    );
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- DELETE --------------------------------- */
customersRouter.delete('/:id', write, async (req, res, next) => {
  try {
    const doc = await Customer.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!doc) throw notFound('Customer not found');
    if (doc.dueBalance > 0) {
      throw conflict(`Cannot delete — this customer still owes ৳${(doc.dueBalance / 100).toFixed(2)}.`, {
        dueBalance: doc.dueBalance,
      });
    }
    await Customer.updateOne({ uuid: doc.uuid }, { $set: { deletedAt: nowIso() } });
    await AuditRepo.log({
      action: 'customer.delete',
      entity: 'customer',
      entityId: doc.uuid,
      before: { name: doc.name, phone: doc.phone },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}
