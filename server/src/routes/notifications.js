/**
 * Notifications — low-stock reminders, debt reminders, daily owner summary.
 *
 * Fully offline-first: the UI reads rows straight from Mongo. SMS is a
 * best-effort side channel: when a provider is configured (env vars) queued
 * rows get a `sent` status + `smsLog`; otherwise they stay local reminders.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Notification } from '../models/Supply.js';
import { lowStockList, queueLowStockNotifications } from '../services/stockService.js';
import { getSettings } from '../models/Settings.js';
import { notFound } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const owner = requireRole('owner');

/* ---------------------------- INBOX (UI list) ---------------------------- */
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'unread');
    const filter = {};
    if (status === 'unread') {
      filter.readAt = null;
    } else if (status !== 'all') {
      filter.status = String(status);
    }

    const items = await Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const unreadCount = await Notification.countDocuments({ readAt: null, status: { $in: ['queued', 'read'] } });
    res.json({ data: items, meta: { unreadCount } });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- LOW STOCK (computed live) --------------------- */
notificationsRouter.get('/low-stock', async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const items = await lowStockList(settings.lowStockDefault ?? 3);
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ REMINDERS ------------------------------- */
/** Queue reminders from the current low-stock state (idempotent). */
notificationsRouter.post('/low-stock/queue', owner, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const result = await queueLowStockNotifications(settings.lowStockDefault ?? 3);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/** Debt reminders for customers with due > 0 (queued; SMS only if enabled). */
notificationsRouter.post('/due-reminders/queue', owner, async (_req, res, next) => {
  try {
    const { coll } = await import('../config/db.js');
    const debtors = await coll('customers')
      .find({ deletedAt: null, dueBalance: { $gt: 0 } })
      .project({ uuid: 1, name: 1, phone: 1, dueBalance: 1 })
      .toArray();

    const at = nowIso();
    let queued = 0;
    for (const c of debtors) {
      const existing = await Notification.findOne({
        kind: 'due_reminder',
        refId: c.uuid,
        status: { $in: ['queued', 'sent'] },
      });
      if (existing) continue;
      await Notification.create({
        kind: 'due_reminder',
        title: `Due reminder: ${c.name}`,
        body: `Owes ৳${(c.dueBalance / 100).toFixed(2)}`,
        toPhone: c.phone || '',
        refType: 'customer',
        refId: c.uuid,
        status: 'queued',
        createdAt: at,
      });
      queued++;
    }
    res.json({ data: { debtors: debtors.length, queued } });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- READ --------------------------------- */
notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const r = await Notification.updateOne(
      { uuid: req.params.id },
      { $set: { readAt: nowIso(), status: 'read' } }
    );
    if (!r.matchedCount) throw notFound('Notification not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- DAILY DIGEST ---------------------------- */
/**
 * Owner's morning summary (today = business date in Asia/Dhaka).
 * Returns a formatted text; POST also persists it into the queue for SMS.
 */
notificationsRouter.get('/daily-digest', owner, async (_req, res, next) => {
  try {
    const text = await buildDigest();
    res.json({ data: text });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/daily-digest', owner, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const text = await buildDigest();
    const doc = await Notification.create({
      kind: 'daily_summary',
      title: 'Daily summary',
      body: text,
      toPhone: settings.sms?.ownerPhone || '',
      status: 'queued',
      createdAt: nowIso(),
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

async function buildDigest() {
  const bizDay = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dhaka' });

  const { Sale } = await import('../models/Sale.js');
  const { Expense } = await import('../models/Finance.js');
  const { coll } = await import('../config/db.js');
  const { getSettings: gs } = await import('../models/Settings.js');

  const settings = await gs();
  const [salesAgg, expAgg, debtors] = await Promise.all([
    Sale.aggregate([
      { $match: { date: bizDay, status: 'completed' } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalCents' }, cogs: { $sum: '$cogsCents' }, due: { $sum: '$payment.dueCents' } } },
    ]),
    Expense.aggregate([
      { $match: { date: bizDay } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ]),
    coll('customers').aggregate([
      { $match: { deletedAt: null, dueBalance: { $gt: 0 } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$dueBalance' } } },
    ]).toArray(),
  ]);

  const s = salesAgg[0] ?? { count: 0, total: 0, cogs: 0, due: 0 };
  const e = expAgg[0] ?? { total: 0 };
  const low = await lowStockList(settings.lowStockDefault ?? 3);

  const tk = (c) => `৳${(c / 100).toFixed(2)}`;
  const lines = [
    `Daily summary — ${bizDay}`,
    `Sales: ${tk(s.total)} (${s.count} receipts)`,
    `Cost: ${tk(s.cogs)} · Expense: ${tk(e.total)}`,
    `Net: ${tk(s.total - s.cogs - e.total)}`,
    `Due taken: ${tk(s.due)} · Customers in debt: ${debtors[0]?.count ?? 0} (${tk(debtors[0]?.total ?? 0)})`,
    low.length ? `Low stock (${low.length}): ${low.slice(0, 5).map((p) => `${p.name}(${p.stock})`).join(', ')}${low.length > 5 ? '…' : ''}` : 'Low stock: none',
  ];
  return lines.join('\n');
}

/* ===================================================================== *
 *  SMS SEND — optional provider hook.
 *
 *  No provider configured → queued rows simply remain the in-app reminder
 *  list (the app is fully usable offline, per the plan). Configure
 *  SMS_PROVIDER=bulksmsbd with SMS_USER/SMS_PASS to enable real sends;
 *  every send attempt is journaled in sms_log for audit.
 * ===================================================================== */
notificationsRouter.post('/send', owner, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 20, 100);
    const result = await sendQueued(limit);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export async function sendQueued(limit = 20) {
  const provider = process.env.SMS_PROVIDER || '';
  const queued = await Notification.find({ status: 'queued', toPhone: { $ne: '' } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  if (!provider) {
    // offline mode: report what WOULD be sent
    return { enabled: false, wouldSend: queued.length, note: 'No SMS provider configured — reminders stay in-app.' };
  }

  const { sendSms } = await import('../services/smsService.js');
  const at = nowIso();
  let sent = 0;
  let failed = 0;
  for (const n of queued) {
    try {
      const resp = await sendSms({ to: n.toPhone, text: `${n.title}\n${n.body}` });
      await Notification.updateOne({ uuid: n.uuid }, { $set: { status: 'sent', sentAt: at } });
      sent++;
    } catch (err) {
      failed++;
      console.warn(`[sms] failed for ${n.uuid}: ${err.message}`);
    }
  }
  return { enabled: true, tried: queued.length, sent, failed };
}
