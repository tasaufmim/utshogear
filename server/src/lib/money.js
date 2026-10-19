/**
 * Money is stored and computed as INTEGER CENTS (baisa-less BDT has 2 decimals).
 * Never use floating point for amounts. ৳ formatting happens only at the UI edge.
 */

export const toCents = (taka) => {
  if (typeof taka === 'number') return Math.round(taka * 100);
  const n = Number(String(taka ?? '').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};

export const fromCents = (cents) => (Number(cents) || 0) / 100;

export const formatTaka = (cents) => {
  const n = fromCents(cents);
  return '৳' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const add = (...cents) => cents.reduce((s, c) => s + (Number(c) || 0), 0);

/** line total after an optional line discount. Discount: {type:'pct'|'amt', val}. */
export function applyDiscount(baseCents, discount) {
  if (!discount || !discount.val) return { base: baseCents, discountAmt: 0, total: baseCents };
  const val = Number(discount.val) || 0;
  let amt = 0;
  if (discount.type === 'pct') {
    amt = Math.round((baseCents * Math.min(Math.max(val, 0), 100)) / 100);
  } else {
    amt = Math.min(Math.max(val, 0), baseCents); // amount discount cannot go negative
  }
  return { base: baseCents, discountAmt: amt, total: baseCents - amt };
}

/** Percentage margin of a price over a cost, both in cents. */
export function marginPct(costCents, priceCents) {
  if (!costCents) return null;
  return Math.round(((priceCents - costCents) / costCents) * 10000) / 100; // 2dp
}

export function marginAmt(costCents, priceCents) {
  return priceCents - costCents;
}

/** target price = cost * (1 + pct/100), in cents */
export function targetPrice(costCents, pct) {
  return Math.round(costCents * (1 + (Number(pct) || 0) / 100));
}

/** Weighted average cost after receiving `qty` units at `unitCost`. */
export function weightedAvgCost(prevAvg, prevStock, qty, unitCost) {
  const stock = prevStock + qty;
  if (stock <= 0) return prevAvg;
  return Math.round((prevAvg * prevStock + unitCost * qty) / stock);
}
