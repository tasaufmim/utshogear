import { Router } from 'express';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { AuditRepo } from '../repos/AuditRepo.js';

export const auditRouter = Router();

auditRouter.use(requireAuth, requireOwner);

/** GET /api/audit?from&to&actorId&entity&action&skip&limit */
auditRouter.get('/', async (req, res, next) => {
  try {
    const { items, total, skip, limit } = await AuditRepo.find(
      {
        from: req.query.from,
        to: req.query.to,
        actorId: req.query.actorId,
        entity: req.query.entity,
        action: req.query.action,
        entityId: req.query.entityId,
      },
      { skip: req.query.skip, limit: req.query.limit }
    );
    res.json({ data: items, meta: { total, skip, limit } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/audit/verify — walk the hash chain, report the first broken link. */
auditRouter.get('/verify', async (_req, res, next) => {
  try {
    res.json({ data: await AuditRepo.verify() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/audit/export.csv */
auditRouter.get('/export.csv', async (req, res, next) => {
  try {
    const csv = await AuditRepo.toCsv({
      from: req.query.from,
      to: req.query.to,
      entity: req.query.entity,
      action: req.query.action,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send('﻿' + csv); // BOM so Excel opens Bangla text correctly
  } catch (err) {
    next(err);
  }
});
