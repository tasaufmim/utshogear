import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Supplier, SupplierPayment, Purchase } from '../models/Supply.js';
import { Product } from '../models/Catalog.js';
import { coll, withTxn } from '../config/db.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { allocateNumber } from '../services/numbering.js';
import { appendMove } from '../services/stockService.js';
import { weightedAvgCost } from '../lib/money.js';
import { conflict, notFound, validation, badRequest } from '../lib/errors.js';
import { nowIso, businessDate, businessDayStartUtc, businessDayEndUtc } from '../lib/dates.js';
import { uuid } from '../lib/ids.js';

const owner = requireRole('owner');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ===================================================================== *
 *  SUPPLIERS + ACCOUNTS PAYABLE
 * ===================================================================== */
export const suppliersRouter = Router();
suppliersRouter.use(requireAuth);

const supplierSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(20).optional(),
  address: z.string().max(160).optional(),
  note: z.string().max(300).optional(),
});

suppliersRouter.get('/', async (req, res, next) => {
  try {
    const filter = { deletedAt: null };
    if (req.query.q) {
      const rx = new RegExp(escapeRe(String(req.query.q)), 'i');
      filter.$or = [{ name: rx }, { phone: rx }];
    }
    const sort =
      req.query.sort === 'due' ? { dueBalance: -1 } : req.query.sort === 'name' ? { name: 1 } : { updatedAt: -1 };
    const items = await Supplier.find(filter).sort(sort).limit(200).lean();
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

suppliersRouter.post('/', async (req, res, next) => {
  try {
    const body = supplierSchema.parse(req.body);
    const at = nowIso();
    if (body.phone) {
      const dup = await Supplier.findOne({ phone: body.phone, deletedAt: null }).lean();
      if (dup) throw conflict(`Supplier phone already belongs to "${dup.name}"`, { field: 'phone' });
    }
    const doc = await Supplier.create({ ...body, createdAt: at, updatedAt: at });
    await AuditRepo.log({
      action: 'supplier.create',
      entity: 'supplier',
      entityId: doc.uuid,
      after: { name: doc.name, phone: doc.phone },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

suppliersRouter.patch('/:id', async (req, res, next) => {
  try {
    const before = await Supplier.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!before) throw notFound('Supplier not found');
    const patch = supplierSchema.partial().parse(req.body);
    const after = await Supplier.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: { ...patch, updatedAt: nowIso() } },
      { new: true }
    ).lean();
    const keys = Object.keys(patch);
    await AuditRepo.log({
      action: 'supplier.update',
      entity: 'supplier',
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

suppliersRouter.get('/:id', async (req, res, next) => {
  try {
    const supplier = await Supplier.findOne({
      $or: [{ uuid: req.params.id }, { phone: req.params.id }],
      deletedAt: null,
    }).lean();
    if (!supplier) throw notFound('Supplier not found');

    const [payments, purchases] = await Promise.all([
      SupplierPayment.find({ supplierId: supplier.uuid }).sort({ createdAt: -1 }).limit(30).lean(),
      Purchase.find({ supplierId: supplier.uuid }).sort({ createdAt: -1 }).limit(30).lean(),
    ]);
    res.json({ data: { ...supplier, payments, purchases } });
  } catch (err) {
    next(err);
  }
});

/** Pay a supplier (AP). Append-only ledger row + cached due update. */
suppliersRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const body = z
      .object({
        amountCents: z.number().int().min(1).max(1_000_000_000),
        method: z.enum(['cash', 'bkash', 'nagad', 'card']).default('cash'),
        note: z.string().max(200).optional(),
        refPurchaseUuid: z.string().max(64).nullable().optional(),
      })
      .parse(req.body);

    const actor = { userId: req.user.userId, name: req.user.name, role: req.user.role };

    const payment = await withTxn(async (session) => {
      const supplier = await Supplier.findOne({ uuid: req.params.id, deletedAt: null }).session(session);
      if (!supplier) throw notFound('Supplier not found');
      if (body.amountCents > Math.abs(supplier.dueBalance)) {
        throw badRequest(
          `Payment exceeds what you owe (৳${(Math.abs(supplier.dueBalance) / 100).toFixed(2)})`,
          { dueBalance: supplier.dueBalance }
        );
      }

      const at = nowIso();
      const doc = {
        uuid: uuid(),
        supplierId: supplier.uuid,
        amountCents: body.amountCents,
        method: body.method,
        note: body.note || '',
        refPurchaseUuid: body.refPurchaseUuid || null,
        createdAt: at,
        userId: actor.userId,
        userName: actor.name,
        syncedAt: null,
      };
      await SupplierPayment.create([doc], { session });

      // dueBalance for suppliers is what WE owe (positive = owed to supplier)
      await Supplier.updateOne(
        { uuid: supplier.uuid },
        { $inc: { dueBalance: -body.amountCents }, $set: { updatedAt: at } },
        { session }
      );

      await AuditRepo.log({
        action: 'supplier.payment',
        entity: 'supplier',
        entityId: supplier.uuid,
        after: { amountCents: body.amountCents, method: body.method, dueAfter: supplier.dueBalance - body.amountCents },
        actor,
        meta: { note: body.note || '' },
        session,
      });
      return doc;
    });

    res.status(201).json({ data: payment });
  } catch (err) {
    next(err);
  }
});

suppliersRouter.delete('/:id', owner, async (req, res, next) => {
  try {
    const doc = await Supplier.findOne({ uuid: req.params.id, deletedAt: null }).lean();
    if (!doc) throw notFound('Supplier not found');
    if (doc.dueBalance > 0) {
      throw conflict(`Cannot delete — you still owe this supplier ৳${(doc.dueBalance / 100).toFixed(2)}.`, {
        dueBalance: doc.dueBalance,
      });
    }
    await Supplier.updateOne({ uuid: doc.uuid }, { $set: { deletedAt: nowIso() } });
    await AuditRepo.log({
      action: 'supplier.delete',
      entity: 'supplier',
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

/* ===================================================================== *
 *  PURCHASES (goods received) — stock IN + landed cost + AP in one txn
 *
 *  landed unit cost = invoice price + allocated freight share.
 *  avgCost  = weightedAvgCost(prevAvg, prevStock, qty, landedCost)
 *  zero-stock products take the landed cost outright (no history to weight).
 * ===================================================================== */
export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);

const purchaseSchema = z.object({
  supplierId: z.string().nullable().optional(),
  supplierInvoice: z.string().max(60).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(99999),
        unitPrice: z.number().int().min(0).max(100_000_000), // cents
      })
    )
    .min(1)
    .max(300),
  extraCostCents: z.number().int().min(0).max(100_000_000).optional(), // freight/duty
  paymentMethod: z.enum(['cash', 'bkash', 'nagad', 'card', 'credit']).default('cash'),
  paidCents: z.number().int().min(0).optional(),
  note: z.string().max(400).optional(),
});

purchasesRouter.post('/', owner, async (req, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    const actor = { userId: req.user.userId, name: req.user.name, role: req.user.role };

    const result = await withTxn(async (session) => {
      /* ---- products in one query ---- */
      const ids = [...new Set(body.lines.map((l) => l.productId))];
      const products = await Product.find({ uuid: { $in: ids }, deletedAt: null })
        .session(session)
        .lean();
      const byId = Object.fromEntries(products.map((p) => [p.uuid, p]));
      for (const l of body.lines) {
        if (!byId[l.productId]) throw validation('Product no longer exists', { productId: l.productId });
      }

      /* ---- supplier ---- */
      let supplier = null;
      if (body.supplierId) {
        supplier = await Supplier.findOne({ uuid: body.supplierId, deletedAt: null }).session(session);
        if (!supplier) throw validation('Unknown supplier', { field: 'supplierId' });
      }

      const extraCost = body.extraCostCents ?? 0;
      const subtotal = body.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
      if (subtotal <= 0) throw validation('Purchase total must be positive');
      const grandTotal = subtotal + extraCost;

      const method = body.paymentMethod;
      if (method === 'credit' && !supplier) {
        throw validation('Credit purchase requires a supplier');
      }
      const paidCents =
        method === 'credit'
          ? 0
          : body.paidCents != null
            ? Math.min(Math.round(body.paidCents), grandTotal)
            : grandTotal;
      const dueCents = grandTotal - paidCents;
      if (dueCents > 0 && !supplier) {
        throw validation('Due payment requires a supplier');
      }

      /* ---- allocate freight by line value; last line absorbs rounding ---- */
      const at = nowIso();
      const lines = [];
      let allocated = 0;
      body.lines.forEach((l, i) => {
        const lineValue = l.unitPrice * l.qty;
        const share =
          i === body.lines.length - 1
            ? extraCost - allocated
            : Math.round((extraCost * lineValue) / subtotal);
        allocated += share;
        const unitCostLanded = l.unitPrice + Math.round(share / l.qty);
        lines.push({
          productId: l.productId,
          sku: byId[l.productId].sku,
          name: byId[l.productId].name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          extraAlloc: share,
          unitCost: unitCostLanded,
          lineTotal: lineValue,
        });
      });

      const ref = await allocateNumber({ kind: 'purchase', prefix: 'PUR', session });

      const purchase = {
        uuid: uuid(),
        ref,
        supplierId: supplier?.uuid ?? null,
        supplierName: supplier?.name ?? 'Walk-in supplier',
        supplierInvoice: body.supplierInvoice || '',
        createdAt: at,
        date: businessDate(new Date(at)),
        lines,
        subtotalCents: subtotal,
        extraCostCents: extraCost,
        grandTotalCents: grandTotal,
        paidCents,
        dueCents,
        paymentMethod: method,
        note: body.note || '',
        userId: actor.userId,
        userName: actor.name,
        syncedAt: null,
      };
      await Purchase.create([purchase], { session });

      /* ---- stock IN + weighted average cost ---- */
      for (const line of lines) {
        const p = byId[line.productId];
        const newAvg = weightedAvgCost(p.avgCost || 0, p.stock || 0, line.qty, line.unitCost);
        await Product.updateOne(
          { uuid: line.productId },
          {
            $set: { avgCost: newAvg, lastPurchasePrice: line.unitPrice, updatedAt: at },
          },
          { session }
        );
        await appendMove(
          {
            productId: line.productId,
            type: 'PURCHASE',
            qty: line.qty,
            unitCost: line.unitCost,
            refType: 'purchase',
            refId: purchase.uuid,
            note: `${ref}${supplier ? ` · ${supplier.name}` : ''}`,
            date: at,
            userId: actor.userId,
          },
          session
        );
      }

      /* ---- AP + supplier stats ---- */
      if (supplier) {
        await Supplier.updateOne(
          { uuid: supplier.uuid },
          {
            $inc: { dueBalance: dueCents, totalPurchased: grandTotal, purchaseCount: 1 },
            $set: { lastPurchaseAt: at, updatedAt: at },
          },
          { session }
        );
      }

      await AuditRepo.log({
        action: 'purchase.create',
        entity: 'purchase',
        entityId: purchase.uuid,
        after: {
          ref,
          supplier: purchase.supplierName,
          lines: lines.length,
          grandTotalCents: grandTotal,
          dueCents,
        },
        actor,
        session,
      });

      return purchase;
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

purchasesRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const filter = {};
    if (req.query.supplierId) filter.supplierId = String(req.query.supplierId);
    if (req.query.from) filter.createdAt = { ...filter.createdAt, $gte: businessDayStartUtc(String(req.query.from).slice(0, 10)) };
    if (req.query.to) filter.createdAt = { ...filter.createdAt, $lt: businessDayEndUtc(String(req.query.to).slice(0, 10)) };
    if (req.query.q) {
      const rx = new RegExp(escapeRe(String(req.query.q)), 'i');
      filter.$or = [{ ref: rx }, { supplierInvoice: rx }, { supplierName: rx }];
    }

    const [items, total] = await Promise.all([
      Purchase.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Purchase.countDocuments(filter),
    ]);
    res.json({ data: items, meta: { total, page, limit } });
  } catch (err) {
    next(err);
  }
});

purchasesRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await Purchase.findOne({
      $or: [{ uuid: req.params.id }, { ref: String(req.params.id).toUpperCase() }],
    }).lean();
    if (!doc) throw notFound('Purchase not found');
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
});
