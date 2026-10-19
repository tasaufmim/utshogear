import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Expense, ExpenseCategory } from '../models/Finance.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, notFound, validation } from '../lib/errors.js';
import { nowIso, businessDate, businessDayStartUtc, businessDayEndUtc } from '../lib/dates.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

const owner = requireRole('owner'); // manageExpenses is owner-only

/* ------------------------------ CATEGORIES ------------------------------- */
expensesRouter.get('/categories', async (_req, res, next) => {
  try {
    const items = await ExpenseCategory.find({ active: true }).sort({ name: 1 }).lean();
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

expensesRouter.post('/categories', owner, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) throw validation('Category name required', { field: 'name' });
    const dup = await ExpenseCategory.findOne({ name: { $regex: new RegExp(`^${escapeRe(name)}$`, 'i') } }).lean();
    if (dup) throw conflict('Category already exists', { field: 'name' });
    const doc = await ExpenseCategory.create({ name, createdAt: nowIso() });
    await AuditRepo.log({
      action: 'expense_category.create',
      entity: 'expense_category',
      entityId: doc.uuid,
      after: { name },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

expensesRouter.delete('/categories/:id', owner, async (req, res, next) => {
  try {
    const doc = await ExpenseCategory.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('Category not found');
    const used = await Expense.countDocuments({ categoryId: doc.uuid });
    if (used > 0) throw conflict(`In use by ${used} entr${used === 1 ? 'y' : 'ies'} — entries keep the name`, { used });
    await ExpenseCategory.deleteOne({ uuid: doc.uuid });
    await AuditRepo.log({
      action: 'expense_category.delete',
      entity: 'expense_category',
      entityId: doc.uuid,
      before: { name: doc.name },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- ENTRIES -------------------------------- */
expensesRouter.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.from) filter.date = { ...filter.date, $gte: String(req.query.from).slice(0, 10) };
    if (req.query.to) filter.date = { ...filter.date, $lte: String(req.query.to).slice(0, 10) };
    if (req.query.categoryId) filter.categoryId = String(req.query.categoryId);

    const [items, total] = await Promise.all([
      Expense.find(filter).sort({ date: -1, createdAt: -1 }).limit(200).lean(),
      Expense.countDocuments(filter),
    ]);
    res.json({ data: items, meta: { total } });
  } catch (err) {
    next(err);
  }
});

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().min(1),
  amountCents: z.number().int().min(1).max(100_000_000_00),
  method: z.enum(['cash', 'bkash', 'nagad', 'card']).default('cash'),
  note: z.string().max(300).optional(),
});

expensesRouter.post('/', owner, async (req, res, next) => {
  try {
    const body = entrySchema.parse(req.body);
    const cat = await ExpenseCategory.findOne({ uuid: body.categoryId, active: true }).lean();
    if (!cat) throw validation('Unknown expense category', { field: 'categoryId' });
    if (body.date > businessDate(new Date())) throw validation('Expense date cannot be in the future', { field: 'date' });

    const at = nowIso();
    const doc = await Expense.create({
      ...body,
      categoryName: cat.name,
      createdAt: at,
      userId: req.user.userId,
      userName: req.user.name,
    });

    await AuditRepo.log({
      action: 'expense.create',
      entity: 'expense',
      entityId: doc.uuid,
      after: { date: doc.date, category: cat.name, amountCents: doc.amountCents, note: doc.note },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

expensesRouter.patch('/:id', owner, async (req, res, next) => {
  try {
    const before = await Expense.findOne({ uuid: req.params.id }).lean();
    if (!before) throw notFound('Entry not found');
    const body = entrySchema.partial().parse(req.body);

    let categoryName = before.categoryName;
    if (body.categoryId && body.categoryId !== before.categoryId) {
      const cat = await ExpenseCategory.findOne({ uuid: body.categoryId, active: true }).lean();
      if (!cat) throw validation('Unknown expense category', { field: 'categoryId' });
      categoryName = cat.name;
    }

    const after = await Expense.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: { ...body, categoryName } },
      { new: true }
    ).lean();

    const keys = Object.keys(body);
    await AuditRepo.log({
      action: 'expense.update',
      entity: 'expense',
      entityId: before.uuid,
      before: { date: before.date, amountCents: before.amountCents, category: before.categoryName, note: before.note },
      after: { date: after.date, amountCents: after.amountCents, category: after.categoryName, note: after.note },
      actor: req.user,
      meta: { keys },
    });
    res.json({ data: after });
  } catch (err) {
    next(err);
  }
});

expensesRouter.delete('/:id', owner, async (req, res, next) => {
  try {
    const doc = await Expense.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('Entry not found');
    await Expense.deleteOne({ uuid: doc.uuid });
    await AuditRepo.log({
      action: 'expense.delete',
      entity: 'expense',
      entityId: doc.uuid,
      before: { date: doc.date, amountCents: doc.amountCents, category: doc.categoryName, note: doc.note },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ DAY TOTAL -------------------------------- */
/** Single-day expense total (used by dashboard + POS-free costing). */
expensesRouter.get('/day-total', async (req, res, next) => {
  try {
    const date = String(req.query.date || businessDate(new Date())).slice(0, 10);
    const start = businessDayStartUtc(date);
    const end = businessDayEndUtc(date);
    const [byDate] = await Expense.aggregate([
      { $match: { date } },
      { $group: { _id: null, total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
    ]);
    res.json({
      data: { date, totalCents: byDate?.total ?? 0, count: byDate?.count ?? 0 },
      meta: { start, end },
    });
  } catch (err) {
    next(err);
  }
});

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
