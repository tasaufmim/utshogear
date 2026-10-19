/**
 * Customer returns / exchanges.
 *
 * Refund is computed from what the customer ACTUALLY PAID per unit
 * (lineTotal / qty), never from today's price — a sale at a discount refunds
 * the discounted amount. Money-back methods:
 *   cash       → handed back at the counter
 *   original   → back through the original channel (bkash refund etc.)
 *   due_adjust → reduces the customer's outstanding debt
 *
 * Every return writes a stock_move (RETURN) for restocked lines and an audit
 * entry; the sale itself is NEVER edited.
 */
import { Sale } from '../models/Sale.js';
import { Return } from '../models/Return.js';
import { coll, withTxn } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso, businessDate } from '../lib/dates.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { allocateNumber } from './numbering.js';
import { appendMove } from './stockService.js';
import { checkoutIn } from './posService.js';
import { getSettings } from '../models/Settings.js';
import { conflict, validation, notFound, forbidden } from '../lib/errors.js';

/**
 * @param {object} input
 * @param {string} input.saleUuid        original sale uuid (or receiptNo)
 * @param {Array}  input.lines           [{productId, qty, reason?, restock?}]
 * @param {'cash'|'original'|'due_adjust'} [input.method]
 * @param {boolean} [input.ownerIdVerified]  owner PIN already checked
 * @param {Array}  [input.exchangeLines] if present → exchange (checkout in same txn)
 * @param {number} [input.extraPaidCents] cash the customer adds on top of the refund
 */
export async function createReturn(input, actor) {
  return withTxn((session) => createReturnIn(input, actor, session));
}

export async function createReturnIn(input, actor, session) {
  const { saleUuid, lines, method = 'cash', ownerIdVerified = false, exchangeLines = null, extraPaidCents = 0 } = input;

  if (!lines?.length) throw validation('Nothing to return');

  /* ---- original sale ---- */
  const sale = await Sale.findOne({
    $or: [{ uuid: saleUuid }, { receiptNo: String(saleUuid).toUpperCase() }],
  })
    .session(session)
    .lean();
  if (!sale) throw notFound('Sale not found for this receipt');
  if (sale.status !== 'completed') throw conflict('Only completed sales can be returned');

  /* ---- return window (settings.returnWindowDays, 0 = unlimited) ---- */
  const settings = await getSettings(session);
  const windowDays = Number(settings?.returnWindowDays ?? 7);
  if (windowDays > 0 && !ownerIdVerified) {
    const ageDays = Math.floor((Date.now() - Date.parse(sale.createdAt)) / 86_400_000);
    if (ageDays > windowDays) {
      throw forbidden(
        `Return window (${windowDays} days) has passed — owner PIN required`,
        'RETURN_WINDOW'
      );
    }
  }

  /* ---- already returned? (returns are additive, never edited) ---- */
  const prevReturns = await Return.find({ saleUuid: sale.uuid }).session(session).lean();
  const returnedSoFar = {};
  for (const r of prevReturns) {
    for (const l of r.lines) returnedSoFar[l.productId] = (returnedSoFar[l.productId] || 0) + l.qty;
  }

  /* ---- build lines, refund at price actually paid ---- */
  const refundLines = [];
  let refundCents = 0;
  for (const line of lines) {
    const orig = sale.lines.find((l) => l.productId === line.productId);
    if (!orig) throw validation('That product is not on this receipt', { productId: line.productId });

    const qty = Math.trunc(Number(line.qty));
    if (!qty || qty < 1) throw validation('Return quantity must be at least 1', { productId: line.productId });

    const already = returnedSoFar[line.productId] || 0;
    const left = orig.qty - already;
    if (qty > left) {
      throw conflict(`Only ${left} of "${orig.name}" left to return on this receipt`, {
        productId: line.productId,
        left,
      });
    }

    const unitRefund = Math.round(orig.lineTotal / orig.qty);
    refundCents += unitRefund * qty;
    refundLines.push({
      productId: orig.productId,
      sku: orig.sku,
      name: orig.name,
      size: orig.size,
      qty,
      unitPrice: unitRefund,
      reason: String(line.reason || '').slice(0, 200),
      restock: line.restock !== false,
    });
  }

  if (refundCents <= 0) throw validation('Refund must be positive');
  if (refundCents > sale.totalCents) throw validation('Refund cannot exceed the sale total');

  if (method === 'due_adjust' && !sale.customerId) {
    throw validation('Debt-adjust refund needs a customer on the sale');
  }

  /* ---- number + document ---- */
  const returnNo = await allocateNumber({
    kind: 'return',
    prefix: settings?.returnPrefix || 'UGRR',
    session,
  });
  const at = nowIso();

  const doc = {
    uuid: uuid(),
    returnNo,
    saleUuid: sale.uuid,
    receiptNo: sale.receiptNo,
    date: businessDate(new Date(at)),
    createdAt: at,
    lines: refundLines,
    refundCents,
    method,
    isExchange: !!exchangeLines?.length,
    exchangeSaleUuid: null,
    customerId: sale.customerId ?? null,
    customerName: sale.customerName ?? 'Walk-in',
    userId: actor.userId,
    userName: actor.name,
    syncedAt: null,
  };
  await Return.create([doc], { session });

  /* ---- stock back for restocked lines ---- */
  for (const line of refundLines) {
    if (!line.restock) continue;
    const orig = sale.lines.find((l) => l.productId === line.productId);
    await appendMove(
      {
        productId: line.productId,
        type: 'RETURN',
        qty: line.qty,
        unitCost: orig?.unitCost ?? 0,
        refType: 'return',
        refId: doc.uuid,
        note: `${returnNo} ← ${sale.receiptNo}`,
        date: at,
        userId: actor.userId,
      },
      session
    );
  }

  /* ---- money back + customer bookkeeping ---- */
  if (sale.customerId) {
    const inc = { totalSpent: -refundCents };
    if (method === 'due_adjust') inc.dueBalance = -refundCents;
    await coll('customers').updateOne(
      { uuid: sale.customerId },
      { $inc: inc, $set: { updatedAt: at } },
      { session }
    );
  }

  /* ---- exchange: replacement sale in the SAME transaction ---- */
  let exchangeSale = null;
  if (exchangeLines?.length) {
    exchangeSale = await checkoutIn(
      {
        clientTxnId: input.exchangeClientTxnId || uuid(),
        lines: exchangeLines,
        payment: { method: 'cash', paidCents: refundCents + (extraPaidCents || 0) },
        customerId: sale.customerId ?? null,
        note: `exchange against ${sale.receiptNo}`,
        ownerIdVerified,
      },
      actor,
      session
    );
    await Return.updateOne({ uuid: doc.uuid }, { $set: { exchangeSaleUuid: exchangeSale.sale.uuid } });
    doc.exchangeSaleUuid = exchangeSale.sale.uuid;
  }

  /* ---- audit ---- */
  await AuditRepo.log({
    action: doc.isExchange ? 'sale.exchange' : 'sale.return',
    entity: 'return',
    entityId: doc.uuid,
    after: {
      returnNo,
      receiptNo: sale.receiptNo,
      refundCents,
      method,
      lines: refundLines.length,
      restocked: refundLines.filter((l) => l.restock).length,
      exchangeReceiptNo: exchangeSale?.sale?.receiptNo ?? null,
    },
    actor,
    meta: { note: refundLines.map((l) => `${l.qty}× ${l.name}`).join(', ') },
    session,
  });

  return { returnDoc: doc, sale: exchangeSale?.sale ?? null };
}
