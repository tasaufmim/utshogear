/**
 * Inventory write helpers — every stock change is a row in `stock_moves`
 * (append-only) plus an update of the cached `products.stock`.
 *
 * Invariant:  products.stock === SUM(stock_moves.qty)  for every product.
 * scripts/reconcile-stock.mjs and GET /api/inventory/reconcile both verify it.
 */
import { Product } from '../models/Catalog.js';
import { Notification } from '../models/Supply.js';
import { coll, withTxn } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso, businessDate } from '../lib/dates.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, validation, notFound } from '../lib/errors.js';

/**
 * Append a stock movement. Call inside a transaction (or let it open one).
 * @param {object} m
 * @param {'OPENING'|'SALE'|'RETURN'|'VOID_RETURN'|'PURCHASE'|'ADJUST'|'EXCHANGE'} m.type
 * @param {number} m.qty   positive = in, negative = out
 */
export async function appendMove(m, session) {
  const at = m.date || nowIso();
  await coll('stock_moves').insertOne(
    {
      uuid: uuid(),
      productId: m.productId,
      type: m.type,
      qty: m.qty,
      unitCost: m.unitCost ?? 0,
      refType: m.refType ?? null,
      refId: m.refId ?? null,
      note: m.note ?? '',
      date: at,
      userId: m.userId ?? null,
      createdAt: at,
    },
    { session }
  );
  await Product.updateOne({ uuid: m.productId }, { $inc: { stock: m.qty } }, { session });
}

/* ===================================================================== *
 *  MANUAL ADJUSTMENT (owner) — damage, theft, recount, wrong entry.
 *  Always audited with before/after stock.
 * ===================================================================== */
export async function adjustStock({ productId, delta, reason, unitCost, actor }) {
  const qty = Math.trunc(Number(delta));
  if (!qty) throw validation('Adjustment quantity cannot be zero');
  if (!reason || !String(reason).trim()) throw validation('An adjustment needs a reason');

  return withTxn(async (session) => {
    const p = await Product.findOne({ uuid: productId, deletedAt: null }).session(session);
    if (!p) throw notFound('Product not found');

    const nextStock = p.stock + qty;
    if (nextStock < 0) {
      throw conflict(
        `Cannot adjust: stock would fall to ${nextStock} (current ${p.stock}, delta ${qty})`,
        { stock: p.stock, delta: qty }
      );
    }

    const at = nowIso();
    await appendMove(
      {
        productId: p.uuid,
        type: 'ADJUST',
        qty,
        unitCost: unitCost ?? p.avgCost,
        note: String(reason).trim(),
        date: at,
        userId: actor.userId,
      },
      session
    );

    await AuditRepo.log({
      action: 'inventory.adjust',
      entity: 'product',
      entityId: p.uuid,
      before: { stock: p.stock },
      after: { stock: nextStock },
      actor,
      meta: { delta: qty, reason: String(reason).trim(), name: p.name, sku: p.sku },
      session,
    });

    return { uuid: p.uuid, stockBefore: p.stock, stockAfter: nextStock };
  });
}

/* ===================================================================== *
 *  RECONCILE — SUM(stock_moves) vs cached products.stock
 * ===================================================================== */
export async function reconcile() {
  const [sums, products] = await Promise.all([
    coll('stock_moves')
      .aggregate([{ $group: { _id: '$productId', total: { $sum: '$qty' } } }])
      .toArray(),
    Product.find({ deletedAt: null }).select('uuid name sku stock').lean(),
  ]);
  const byId = Object.fromEntries(sums.map((s) => [s._id, s.total]));

  const rows = products.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    sku: p.sku,
    cached: p.stock,
    ledger: byId[p.uuid] ?? 0,
    match: (byId[p.uuid] ?? 0) === p.stock,
  }));
  return {
    ok: rows.every((r) => r.match),
    checked: rows.length,
    mismatches: rows.filter((r) => !r.match),
  };
}

/* ===================================================================== *
 *  LOW STOCK — live evaluation (level = product's own or shop default)
 * ===================================================================== */
export async function lowStockList(defaultLevel = 3) {
  const products = await Product.find({ deletedAt: null, active: true })
    .select('uuid name sku stock reorderLevel categoryId sellPrice avgCost')
    .lean();

  const low = products
    .map((p) => ({ ...p, level: p.reorderLevel || defaultLevel }))
    .filter((p) => p.stock <= p.level)
    .sort((a, b) => a.stock - b.stock);

  return low;
}

/**
 * Queue a low-stock notification row per flagged product (idempotent:
 * an unread row for the same product is not duplicated). Used by the
 * daily digest / SMS queue.
 */
export async function queueLowStockNotifications(defaultLevel = 3) {
  const low = await lowStockList(defaultLevel);
  const at = nowIso();
  let created = 0;

  for (const p of low) {
    const existing = await Notification.findOne({
      kind: 'low_stock',
      refId: p.uuid,
      status: { $in: ['queued', 'sent'] },
    });
    if (existing) continue;
    await Notification.create({
      kind: 'low_stock',
      title: `Low stock: ${p.name}`,
      body: `${p.stock} left (level ${p.level}) — ${p.sku}`,
      refType: 'product',
      refId: p.uuid,
      status: 'queued',
      createdAt: at,
    });
    created++;
  }
  return { flagged: low.length, queued: created };
}
