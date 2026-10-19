import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Category, Brand, BikeModel, buildSearchText } from '../models/Catalog.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, notFound, validation } from '../lib/errors.js';

const write = requireRole('owner');

/* ============================ Categories ============================ */
export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const catSchema = z.object({
  name: z.string().min(1).max(60),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

categoriesRouter.get('/', async (_req, res, next) => {
  try {
    const [items, counts] = await Promise.all([
      Category.find({ deletedAt: null }).sort({ sortOrder: 1, name: 1 }).lean(),
      // active product count per category (aggregate; no N+1)
      (await import('../models/Catalog.js')).Product.aggregate([
        { $match: { deletedAt: null, active: true } },
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]),
    ]);
    const byCat = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    res.json({
      data: items.map((c) => ({ ...c, productCount: byCat[c.uuid] || 0 })),
    });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.post('/', write, async (req, res, next) => {
  try {
    const body = catSchema.parse(req.body);
    const dup = await Category.findOne({
      searchText: buildSearchText(body.name),
      deletedAt: null,
    }).lean();
    if (dup) throw conflict('A category with this name already exists', { field: 'name' });

    const doc = await Category.create({ ...body, searchText: buildSearchText(body.name) });
    await AuditRepo.log({
      action: 'category.create',
      entity: 'category',
      entityId: doc.uuid,
      after: { name: doc.name, parentId: doc.parentId },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.patch('/:id', write, async (req, res, next) => {
  try {
    const body = catSchema.partial().parse(req.body);
    const before = await Category.findOne({ uuid: req.params.id }).lean();
    if (!before) throw notFound('Category not found');

    if (body.name) body.searchText = buildSearchText(body.name);
    const after = await Category.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: body },
      { new: true }
    ).lean();

    await AuditRepo.log({
      action: 'category.update',
      entity: 'category',
      entityId: before.uuid,
      before: { name: before.name, parentId: before.parentId, sortOrder: before.sortOrder },
      after: { name: after.name, parentId: after.parentId, sortOrder: after.sortOrder },
      actor: req.user,
    });
    res.json({ data: after });
  } catch (err) {
    next(err);
  }
});

categoriesRouter.delete('/:id', write, async (req, res, next) => {
  try {
    const doc = await Category.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('Category not found');

    const { Product } = await import('../models/Catalog.js');
    const used = await Product.countDocuments({ categoryId: doc.uuid, deletedAt: null });
    if (used > 0) {
      throw conflict(`Cannot delete — ${used} product(s) still use this category. Move them first.`, {
        productCount: used,
      });
    }

    await Category.updateOne({ uuid: req.params.id }, { $set: { deletedAt: new Date().toISOString() } });
    await AuditRepo.log({
      action: 'category.delete',
      entity: 'category',
      entityId: doc.uuid,
      before: { name: doc.name },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ============================== Brands ============================== */
export const brandsRouter = Router();
brandsRouter.use(requireAuth);

brandsRouter.get('/', async (_req, res, next) => {
  try {
    const items = await Brand.find({ deletedAt: null }).sort({ name: 1 }).lean();
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

brandsRouter.post('/', write, async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    const dup = await Brand.findOne({ name: body.name.trim() }).lean();
    if (dup) throw conflict('Brand already exists', { field: 'name' });
    const doc = await Brand.create({ name: body.name.trim() });
    await AuditRepo.log({
      action: 'brand.create',
      entity: 'brand',
      entityId: doc.uuid,
      after: { name: doc.name },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

brandsRouter.delete('/:id', write, async (req, res, next) => {
  try {
    const doc = await Brand.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('Brand not found');
    await Brand.updateOne({ uuid: req.params.id }, { $set: { deletedAt: new Date().toISOString() } });
    await AuditRepo.log({
      action: 'brand.delete',
      entity: 'brand',
      entityId: doc.uuid,
      before: { name: doc.name },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ============================ Bike models =========================== */
export const bikeModelsRouter = Router();
bikeModelsRouter.use(requireAuth);

bikeModelsRouter.get('/', async (_req, res, next) => {
  try {
    const items = await BikeModel.find({ deletedAt: null }).sort({ make: 1, name: 1 }).lean();
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

const bikeSchema = z.object({
  name: z.string().min(1).max(60),
  make: z.string().min(1).max(40).optional(),
});

bikeModelsRouter.post('/', write, async (req, res, next) => {
  try {
    const body = bikeSchema.parse(req.body);
    const dup = await BikeModel.findOne({ name: body.name.trim() }).lean();
    if (dup) throw conflict('Bike model already exists', { field: 'name' });
    const doc = await BikeModel.create({ name: body.name.trim(), make: body.make?.trim() || 'Other' });
    await AuditRepo.log({
      action: 'bikemodel.create',
      entity: 'bikemodel',
      entityId: doc.uuid,
      after: { name: doc.name, make: doc.make },
      actor: req.user,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});

bikeModelsRouter.patch('/:id', write, async (req, res, next) => {
  try {
    const body = bikeSchema.partial().parse(req.body);
    const before = await BikeModel.findOne({ uuid: req.params.id }).lean();
    if (!before) throw notFound('Bike model not found');
    const after = await BikeModel.findOneAndUpdate(
      { uuid: req.params.id },
      { $set: body },
      { new: true }
    ).lean();
    await AuditRepo.log({
      action: 'bikemodel.update',
      entity: 'bikemodel',
      entityId: before.uuid,
      before: { name: before.name, make: before.make, active: before.active },
      after: { name: after.name, make: after.make, active: after.active },
      actor: req.user,
    });
    res.json({ data: after });
  } catch (err) {
    next(err);
  }
});

bikeModelsRouter.delete('/:id', write, async (req, res, next) => {
  try {
    const doc = await BikeModel.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('Bike model not found');
    await BikeModel.updateOne({ uuid: req.params.id }, { $set: { deletedAt: new Date().toISOString() } });
    await AuditRepo.log({
      action: 'bikemodel.delete',
      entity: 'bikemodel',
      entityId: doc.uuid,
      before: { name: doc.name },
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
