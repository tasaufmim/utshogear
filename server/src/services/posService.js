import { Sale, Park } from '../models/Sale.js';
import { Product } from '../models/Catalog.js';
import { coll, withTxn } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso, businessDate } from '../lib/dates.js';
import { applyDiscount } from '../lib/money.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { allocateNumber } from './numbering.js';
import { badRequest, conflict, notFound, validation, forbidden } from '../lib/errors.js';

/* ===================================================================== *
 *  CHECKOUT — one transaction: receipt number + sale + stock + ledger +
 *  customer due + audit entry. Either everything commits or nothing does.
 * ===================================================================== */
export async function checkout(input, actor) {
  return withTxn((session) => checkoutIn(input, actor, session));
}

/** Same logic, callable inside an outer transaction (used by exchanges). */
export async function checkoutIn(input, actor, session) {
  const {
    clientTxnId,
    lines,
    orderDiscount,
    payment,
    customerId,
    customerName,
    customerPhone,
    note,
    parkUuid,
    ownerIdVerified, // route set this after verifying the owner PIN
  } = input;

  {
    /* ---- idempotency: same cart submitted twice (double-tap, retry) ---- */
    if (clientTxnId) {
      const existing = await Sale.findOne({ clientTxnId }).session(session).lean();
      if (existing) return { duplicate: true, sale: existing };
    }

    if (!lines?.length) throw validation('A sale needs at least one line');

    /* ---- load products in one query ---- */
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const products = await Product.find({ uuid: { $in: productIds }, deletedAt: null })
      .session(session)
      .lean();
    const byId = Object.fromEntries(products.map((p) => [p.uuid, p]));

    /* ---- per-line validation + money (integer cents throughout) ---- */
    const saleLines = [];
    let subtotal = 0;
    let sumLineDiscount = 0;
    let cogs = 0;

    for (const line of lines) {
      const p = byId[line.productId];
      if (!p) throw validation(`Product no longer exists`, { productId: line.productId });

      const qty = Math.floor(Number(line.qty));
      if (!Number.isFinite(qty) || qty < 1) throw validation(`Quantity must be at least 1`, { productId: p.uuid });
      if (p.stock < qty) {
        throw conflict(`Only ${p.stock} × "${p.name}" in stock`, { productId: p.uuid, stock: p.stock });
      }

      const unitPrice = Math.round(Number(line.unitPrice));
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw validation('Invalid price', { productId: p.uuid });

      /* floor-price guard: cashier may not sell below floor without owner PIN */
      if (p.floorPrice > 0 && unitPrice < p.floorPrice && !ownerIdVerified) {
        throw forbidden(
          `Below floor price for "${p.name}" — owner PIN required (floor ৳${(p.floorPrice / 100).toFixed(0)})`,
          'BELOW_FLOOR'
        );
      }

      const base = unitPrice * qty;
      const { discountAmt, total } = applyDiscount(base, line.lineDiscount);
      const unitCost = Number(p.avgCost) || 0;

      saleLines.push({
        uuid: uuid(),
        productId: p.uuid,
        sku: p.sku,
        barcode: p.barcode,
        name: p.name,
        size: p.size,
        qty,
        unitPrice,
        mrpAtSale: p.mrp ?? p.sellPrice,
        lineDiscountCents: discountAmt,
        unitCost,
        cogs: unitCost * qty,
        lineTotal: total,
        warrantyDays: p.warrantyDays ?? 0,
      });

      subtotal += base;
      sumLineDiscount += discountAmt;
      cogs += unitCost * qty;
    }

    /* ---- order-level discount ---- */
    const afterLines = subtotal - sumLineDiscount;
    const orderDisc = applyDiscount(afterLines, orderDiscount);
    const totalCents = orderDisc.total;

    if (totalCents < 0) throw validation('Discount exceeds the order total');
    if (orderDisc.discountAmt > 0 && !ownerIdVerified) {
      const pct = afterLines ? (orderDisc.discountAmt / afterLines) * 100 : 0;
      if (pct > 10) {
        throw forbidden(
          `Order discount of ${pct.toFixed(0)}% needs the owner PIN (limit 10% for cashiers)`,
          'BIG_DISCOUNT'
        );
      }
    }

    /* ---- payment ---- */
    const method = payment?.method ?? 'cash';
    if (method === 'due' && !customerId) {
      throw validation('A due (credit) sale requires a customer');
    }
    let paidCents = 0;
    let dueCents = 0;
    let changeCents = 0;

    if (method === 'due') {
      dueCents = totalCents;
    } else if (method === 'cash') {
      paidCents = payment?.paidCents != null ? Math.round(Number(payment.paidCents)) : totalCents;
      if (paidCents < totalCents) dueCents = totalCents - paidCents; // partial cash
      else changeCents = paidCents - totalCents;
    } else {
      paidCents = totalCents; // bkash / nagad / card settle exactly
    }

    /* ---- customer (due cache is reconcilable against sales) ---- */
    let cust = null;
    if (customerId) {
      cust = await coll('customers').findOne({ uuid: customerId }, { session });
      if (!cust) throw validation('Unknown customer', { field: 'customerId' });
    }

    /* ---- receipt number ---- */
    const settings = await coll('settings').findOne({ uuid: 'settings-singleton' }, { session });
    const receiptNo = await allocateNumber({
      kind: 'receipt',
      prefix: settings?.receiptPrefix || 'UGR',
      session,
    });

    /* ---- assemble sale ---- */
    const at = nowIso();
    const sale = {
      uuid: uuid(),
      receiptNo,
      clientTxnId: clientTxnId || null,
      date: businessDate(new Date(at)),
      createdAt: at,
      updatedAt: at,
      lines: saleLines,
      subtotalCents: subtotal,
      orderDiscountCents: orderDisc.discountAmt,
      orderDiscountType: orderDisc.discountAmt > 0 ? (orderDiscount?.type ?? null) : null,
      totalCents,
      cogsCents: cogs,
      profitCents: totalCents - cogs,
      payment: { method, paidCents, changeCents, dueCents },
      customerId: customerId ?? null,
      customerName: cust?.name ?? customerName ?? 'Walk-in',
      customerPhone: cust?.phone ?? customerPhone ?? '',
      salesmanId: actor.userId,
      salesmanName: actor.name,
      status: 'completed',
      note: note ?? '',
      syncedAt: null,
    };

    await Sale.create([sale], { session });

    /* ---- stock ledger + cache ---- */
    for (const line of saleLines) {
      await coll('stock_moves').insertOne(
        {
          uuid: uuid(),
          productId: line.productId,
          type: 'SALE',
          qty: -line.qty,
          unitCost: line.unitCost,
          refType: 'sale',
          refId: sale.uuid,
          note: receiptNo,
          date: at,
          userId: actor.userId,
          createdAt: at,
        },
        { session }
      );
      await Product.updateOne({ uuid: line.productId }, { $inc: { stock: -line.qty } }, { session });
    }

    /* ---- due owed moves onto the customer's balance ---- */
    if (cust && dueCents > 0) {
      await coll('customers').updateOne(
        { uuid: cust.uuid },
        {
          $inc: { dueBalance: dueCents, totalSpent: totalCents, visitCount: 1 },
          $set: { lastVisitAt: at, updatedAt: at },
        },
        { session }
      );
    } else if (cust) {
      await coll('customers').updateOne(
        { uuid: cust.uuid },
        {
          $inc: { totalSpent: totalCents, visitCount: 1 },
          $set: { lastVisitAt: at, updatedAt: at },
        },
        { session }
      );
    }

    /* ---- parked cart consumed ---- */
    if (parkUuid) {
      await Park.updateOne({ uuid: parkUuid }, { $set: { status: 'checked_out', updatedAt: at } }, { session });
    }

    /* ---- immutable audit entry shares this transaction ---- */
    await AuditRepo.log({
      action: 'sale.create',
      entity: 'sale',
      entityId: sale.uuid,
      after: {
        receiptNo,
        totalCents,
        profitCents: sale.profitCents,
        lines: saleLines.length,
        payment: sale.payment,
        customer: sale.customerName,
        belowFloor: saleLines.some(
          (l) => byId[l.productId]?.floorPrice > 0 && l.unitPrice < byId[l.productId].floorPrice
        ),
        orderDiscountCents: orderDisc.discountAmt,
      },
      actor,
      session,
    });

    return { duplicate: false, sale };
  }
}

/* ===================================================================== *
 *  VOID — stock flows back, sale is marked (never deleted), full audit.
 * ===================================================================== */
export async function voidSale({ saleUuid, reason, actor }) {
  return withTxn(async (session) => {
    const sale = await Sale.findOne({ uuid: saleUuid }).session(session).lean();
    if (!sale) throw notFound('Sale not found');
    if (sale.status === 'voided') throw conflict('This sale is already voided');

    const at = nowIso();

    await Sale.updateOne(
      { uuid: saleUuid },
      {
        $set: {
          status: 'voided',
          voidedAt: at,
          voidReason: reason || '(no reason given)',
          voidedBy: actor.userId,
          updatedAt: at,
        },
      },
      { session }
    );

    for (const line of sale.lines) {
      await coll('stock_moves').insertOne(
        {
          uuid: uuid(),
          productId: line.productId,
          type: 'VOID_RETURN',
          qty: line.qty,
          unitCost: line.unitCost,
          refType: 'sale',
          refId: sale.uuid,
          note: `void ${sale.receiptNo}`,
          date: at,
          userId: actor.userId,
          createdAt: at,
        },
        { session }
      );
      await Product.updateOne({ uuid: line.productId }, { $inc: { stock: line.qty } }, { session });
    }

    if (sale.customerId && sale.payment?.dueCents > 0) {
      await coll('customers').updateOne(
        { uuid: sale.customerId },
        { $inc: { dueBalance: -sale.payment.dueCents }, $set: { updatedAt: at } },
        { session }
      );
    }

    await AuditRepo.log({
      action: 'sale.void',
      entity: 'sale',
      entityId: sale.uuid,
      before: {
        receiptNo: sale.receiptNo,
        status: 'completed',
        totalCents: sale.totalCents,
        customer: sale.customerName,
        lines: sale.lines.length,
      },
      after: { status: 'voided', reason: reason || '(no reason given)' },
      actor,
      meta: { receiptNo: sale.receiptNo },
      session,
    });

    return { ok: true, receiptNo: sale.receiptNo };
  });
}

/* ===================================================================== *
 *  PARK (hold) / recall / discard
 * ===================================================================== */
export async function parkCart(input, actor) {
  const at = nowIso();
  const lines = (input.lines ?? []).map((l) => ({
    productId: l.productId,
    qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
    unitPrice: Math.round(Number(l.unitPrice) || 0),
    lineDiscountCents: Math.round(Number(l.lineDiscountCents) || 0),
  }));
  if (!lines.length) throw validation('Nothing to park');

  if (input.parkUuid) {
    const updated = await Park.findOneAndUpdate(
      { uuid: input.parkUuid },
      { $set: { lines, name: input.name, note: input.note, updatedAt: at, status: 'held' } },
      { new: true }
    ).lean();
    if (!updated) throw notFound('Parked cart not found');
    return updated;
  }

  const doc = await Park.create({
    uuid: uuid(),
    name: input.name || `Hold ${new Date().toISOString().slice(11, 16)}`,
    lines,
    customerId: input.customerId ?? null,
    note: input.note ?? '',
    createdAt: at,
    updatedAt: at,
    createdBy: actor.userId,
  });
  return doc;
}
