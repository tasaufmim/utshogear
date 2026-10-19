/**
 * Reports — the read side of the business.
 *
 * Ranges are BUSINESS DATE STRINGS (YYYY-MM-DD): no timezone parsing, same
 * results locally and on Atlas. `series` returns one bucket per day; the
 * client folds days into weeks/months for the weekly/monthly/6-month views,
 * which keeps bucketing logic in one place and lets the charts switch periods
 * instantly without new requests.
 *
 * Role note: `summary` is the one endpoint cashiers may read (dashboard);
 * everything else is owner-only (viewReports). Profit/cost fields are never
 * assembled for cashiers.
 */
import { Router } from 'express';
import { requireAuth, requireRole, stripFor } from '../middleware/auth.js';
import { Sale } from '../models/Sale.js';
import { Expense } from '../models/Finance.js';
import { Customer, CustomerPayment } from '../models/Customer.js';
import { SupplierPayment } from '../models/Supply.js';
import { Product } from '../models/Catalog.js';
import { coll } from '../config/db.js';
import { getSettings } from '../models/Settings.js';
import { lowStockList } from '../services/stockService.js';
import { badRequest } from '../lib/errors.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const owner = requireRole('owner'); // viewReports

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

function readRange(req) {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    throw badRequest('Dates must be YYYY-MM-DD');
  }
  if (from && to && from > to) throw badRequest('from must be before to');
  return { from: from || today(), to: to || today() };
}

/** Completed, non-voided sales in [from, to] as a match stage. */
const saleMatch = (from, to, extra = {}) => ({
  date: { $gte: from, $lte: to },
  status: 'completed',
  ...extra,
});

/* ===================================================================== *
 *  SUMMARY — dashboard KPIs (both roles, cashier gets a trimmed shape)
 * ===================================================================== */
reportsRouter.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = readRange(req);
    const isOwner = req.user.role === 'owner';

    const [salesAgg, expAgg, dueAgg, newCustomers, settings] = await Promise.all([
      Sale.aggregate([
        { $match: saleMatch(from, to) },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            total: { $sum: '$totalCents' },
            cogs: { $sum: '$cogsCents' },
            due: { $sum: '$payment.dueCents' },
            paid: { $sum: '$payment.paidCents' },
          },
        },
      ]),
      isOwner
        ? Expense.aggregate([
            { $match: { date: { $gte: from, $lte: to } } },
            { $group: { _id: null, total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
      coll('customers')
        .aggregate([
          { $match: { deletedAt: null, dueBalance: { $gt: 0 } } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$dueBalance' } } },
        ])
        .toArray(),
      Customer.countDocuments({ createdAt: { $gte: from, $lte: `${to}~` }, deletedAt: null }).catch(() => 0),
      getSettings().catch(() => ({})),
    ]);

    const s = salesAgg[0] ?? { count: 0, total: 0, cogs: 0, due: 0, paid: 0 };
    const e = expAgg[0] ?? { total: 0, count: 0 };
    const low = await lowStockList(settings.lowStockDefault ?? 3);

    const full = {
      range: { from, to },
      sales: { count: s.count, totalCents: s.total, cogsCents: s.cogs, profitCents: s.total - s.cogs, dueCents: s.due, paidCents: s.paid },
      expenses: { totalCents: e.total, count: e.count },
      netCents: s.total - s.cogs - e.total,
      receivable: { count: dueAgg[0]?.count ?? 0, totalCents: dueAgg[0]?.total ?? 0 },
      newCustomers,
      lowStock: low.length,
      lowStockItems: low.slice(0, 6).map((p) => ({ uuid: p.uuid, name: p.name, stock: p.stock, level: p.level })),
    };

    if (!isOwner) {
      // cashier: no cost / profit / expense figures
      return res.json({
        data: {
          range: full.range,
          sales: { count: full.sales.count, totalCents: full.sales.totalCents },
          receivable: full.receivable,
          lowStock: full.lowStock,
          lowStockItems: full.lowStockItems,
        },
      });
    }
    res.json({ data: full });
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  SERIES — per-day sales + expenses (owner). Client folds to week/month.
 * ===================================================================== */
reportsRouter.get('/series', owner, async (req, res, next) => {
  try {
    const { from, to } = readRange(req);

    const [sales, expenses] = await Promise.all([
      Sale.aggregate([
        { $match: saleMatch(from, to) },
        {
          $group: {
            _id: '$date',
            count: { $sum: 1 },
            total: { $sum: '$totalCents' },
            cogs: { $sum: '$cogsCents' },
            due: { $sum: '$payment.dueCents' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Expense.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: '$date', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const byDate = {};
    for (const row of sales) {
      byDate[row._id] = {
        date: row._id,
        count: row.count,
        totalCents: row.total,
        cogsCents: row.cogs,
        profitCents: row.total - row.cogs,
        dueCents: row.due,
        expensesCents: 0,
        expenseCount: 0,
      };
    }
    for (const row of expenses) {
      const slot = (byDate[row._id] ??= {
        date: row._id,
        count: 0,
        totalCents: 0,
        cogsCents: 0,
        profitCents: 0,
        dueCents: 0,
        expensesCents: 0,
        expenseCount: 0,
      });
      slot.expensesCents = row.total;
      slot.expenseCount = row.count;
    }

    res.json({ data: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  TOP PRODUCTS — owner
 * ===================================================================== */
reportsRouter.get('/top-products', owner, async (req, res, next) => {
  try {
    const { from, to } = readRange(req);
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const rows = await Sale.aggregate([
      { $match: saleMatch(from, to) },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.productId',
          name: { $first: '$lines.name' },
          sku: { $first: '$lines.sku' },
          qty: { $sum: '$lines.qty' },
          revenue: { $sum: '$lines.lineTotal' },
          cogs: { $sum: '$lines.cogs' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
    ]);

    res.json({
      data: rows.map((r) => ({
        productId: r._id,
        name: r.name,
        sku: r.sku,
        qty: r.qty,
        revenueCents: r.revenue,
        profitCents: r.revenue - r.cogs,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  EXPENSES BY CATEGORY — owner (pie chart)
 * ===================================================================== */
reportsRouter.get('/expenses-by-category', owner, async (req, res, next) => {
  try {
    const { from, to } = readRange(req);
    const rows = await Expense.aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $group: { _id: '$categoryName', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);
    res.json({
      data: rows.map((r) => ({ category: r._id, totalCents: r.total, count: r.count })),
    });
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  CASHBOOK — money in vs money out, per day (owner)
 * ===================================================================== */
reportsRouter.get('/cashbook', owner, async (req, res, next) => {
  try {
    const { from, to } = readRange(req);

    // payment timestamps are ISO UTC strings; bucket them by the same
    // Asia/Dhaka business date the sales/expenses use (UTC+6, no DST)
    const BD_OFFSET_MS = 6 * 3600_000;
    const bizStartUtc = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - BD_OFFSET_MS).toISOString();
    const bizEndUtc = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000 - BD_OFFSET_MS).toISOString();
    const bizBucket = {
      $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$createdAt' }, timezone: 'Asia/Dhaka' },
    };

    const [salesPaid, custPaid, expenses, supPaid] = await Promise.all([
      Sale.aggregate([
        { $match: saleMatch(from, to) },
        {
          $group: {
            _id: '$date',
            cash: { $sum: '$payment.paidCents' },
            due: { $sum: '$payment.dueCents' },
          },
        },
      ]),
      CustomerPayment.aggregate([
        { $match: { createdAt: { $gte: bizStartUtc(from), $lt: bizEndUtc(to) } } },
        { $group: { _id: bizBucket, total: { $sum: '$amountCents' } } },
      ]),
      Expense.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: '$date', total: { $sum: '$amountCents' } } },
      ]),
      SupplierPayment.aggregate([
        { $match: { createdAt: { $gte: bizStartUtc(from), $lt: bizEndUtc(to) } } },
        { $group: { _id: bizBucket, total: { $sum: '$amountCents' } } },
      ]),
    ]);

    const days = new Map();
    const slot = (d) => {
      if (!days.has(d)) days.set(d, { date: d, salesIn: 0, customerPaid: 0, expensesOut: 0, supplierPaid: 0, salesDue: 0 });
      return days.get(d);
    };
    for (const r of salesPaid) {
      const s = slot(r._id);
      s.salesIn += r.cash;
      s.salesDue += r.due;
    }
    for (const r of custPaid) slot(r._id).customerPaid += r.total;
    for (const r of expenses) slot(r._id).expensesOut += r.total;
    for (const r of supPaid) slot(r._id).supplierPaid += r.total;

    const lines = [...days.values()]
      .map((d) => ({ ...d, netCents: d.salesIn + d.customerPaid - d.expensesOut - d.supplierPaid }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals = lines.reduce(
      (acc, d) => ({
        salesIn: acc.salesIn + d.salesIn,
        customerPaid: acc.customerPaid + d.customerPaid,
        expensesOut: acc.expensesOut + d.expensesOut,
        supplierPaid: acc.supplierPaid + d.supplierPaid,
        net: acc.net + d.netCents,
      }),
      { salesIn: 0, customerPaid: 0, expensesOut: 0, supplierPaid: 0, net: 0 }
    );

    res.json({ data: { range: { from, to }, lines, totals } });
  } catch (err) {
    next(err);
  }
});

/* ===================================================================== *
 *  PROFIT LEDGER — one row per day: revenue − cogs − expenses (owner)
 * ===================================================================== */
reportsRouter.get('/profit', owner, async (req, res, next) => {
  try {
    const { from, to } = readRange(req);
    const series = await reportsSeries(from, to);
    const totals = series.reduce(
      (a, d) => ({
        sales: a.sales + d.totalCents,
        cogs: a.cogs + d.cogsCents,
        expenses: a.expenses + d.expensesCents,
        profit: a.profit + d.profitCents - d.expensesCents,
        count: a.count + d.count,
      }),
      { sales: 0, cogs: 0, expenses: 0, profit: 0, count: 0 }
    );
    res.json({ data: { range: { from, to }, totals, series } });
  } catch (err) {
    next(err);
  }
});

/** shared series fetch used by /profit */
async function reportsSeries(from, to) {
  const [sales, expenses] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch(from, to) },
      { $group: { _id: '$date', count: { $sum: 1 }, total: { $sum: '$totalCents' }, cogs: { $sum: '$cogsCents' } } },
    ]),
    Expense.aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $group: { _id: '$date', total: { $sum: '$amountCents' } } },
    ]),
  ]);
  const byDate = {};
  for (const r of sales) byDate[r._id] = { date: r._id, count: r.count, totalCents: r.total, cogsCents: r.cogs, profitCents: r.total - r.cogs, expensesCents: 0 };
  for (const r of expenses) (byDate[r._id] ??= { date: r._id, count: 0, totalCents: 0, cogsCents: 0, profitCents: 0, expensesCents: 0 }).expensesCents = r.total;
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}
