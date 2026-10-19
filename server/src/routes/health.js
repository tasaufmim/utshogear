import { Router } from 'express';
import { env } from '../config/env.js';
import { pingMongo } from '../config/db.js';
import { coll } from '../config/db.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res, next) => {
  try {
    const lagMs = await pingMongo().catch(() => -1);

    let pending = 0;
    let syncedAt = null;
    const state = await coll('sync_state').findOne({ _id: 'audit_push' }).catch(() => null);
    if (state) {
      syncedAt = state.lastPushedAt ?? null;
    }

    res.json({
      ok: lagMs >= 0,
      mode: env.readonly ? 'ro' : 'rw',
      version: '1.0.0',
      dbLagMs: lagMs,
      sync: { enabled: env.syncEnabled, pending, syncedAt },
      now: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
