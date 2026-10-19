/**
 * Sync control (owner only) — one-way push of the local database to Atlas so
 * the owner's READONLY remote instance can serve reports.
 *
 *   GET  /api/sync/status   configured? last push, audit cursor, errors
 *   POST /api/sync/push     run a push now (manual)
 *
 * The actual interval loop runs inside index.js (startSyncLoop).
 */
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { pushOnce, getSyncStatus } from '../services/syncService.js';

export const syncRouter = Router();
syncRouter.use(requireAuth, requireRole('owner'));

syncRouter.get('/status', async (_req, res, next) => {
  try {
    res.json({ data: await getSyncStatus() });
  } catch (err) {
    next(err);
  }
});

syncRouter.post('/push', async (_req, res, next) => {
  try {
    const result = await pushOnce();
    res.status(result.skipped ? 200 : result.ok ? 200 : 502).json({ data: result });
  } catch (err) {
    next(err);
  }
});
