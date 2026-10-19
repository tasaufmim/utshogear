/**
 * One-way push sync: LOCAL Mongo → Atlas.
 *
 * The local database is the single source of truth (offline-first shop).
 * The owner's remote instance is a second copy of this app running with
 * READONLY=1 against Atlas — it never writes, so pushing is a plain mirror:
 *
 *   - every business collection: replace-by-uuid (upsert) + delete rows on
 *     Atlas whose uuid no longer exists locally  →  Atlas == local, byte
 *     for byte, including the effect of hard deletes
 *   - audit_log: append-only by `seq` cursor (state in sync_state); the tail
 *     is re-pushed atomically enough for idempotent retries
 *   - counters / sync_state stay local (the read-only remote never allocates)
 *
 * Push happens from THIS (local) instance over the driver — the HTTP
 * readonlyGuard is untouched. Failures never crash the shop: each collection
 * is isolated, errors are returned/logged, and the next interval retries.
 */
import { MongoClient } from 'mongodb';
import { coll } from '../config/db.js';
import { env } from '../config/env.js';
import { nowIso } from '../lib/dates.js';

/** Collections mirrored by uuid (local → Atlas). */
const MIRROR = [
  'users',
  'settings',
  'categories',
  'brands',
  'bike_models',
  'products',
  'stock_moves',
  'purchases',
  'suppliers',
  'supplier_payments',
  'sales',
  'parks',
  'returns',
  'customers',
  'customer_payments',
  'expenses',
  'expense_categories',
  'notifications',
  'sms_log',
];

const CHUNK = 500;

let atlasClient = null;
let running = false;

export function syncConfigured() {
  return Boolean(env.syncEnabled && env.atlasUrl) && !env.readonly;
}

async function getAtlas() {
  if (!env.atlasUrl) throw new Error('ATLAS_URL is not configured');
  if (!atlasClient) {
    atlasClient = new MongoClient(env.atlasUrl, {
      serverSelectionTimeoutMS: 8000,
      appName: 'utsho-gear-push',
    });
    await atlasClient.connect();
  }
  return atlasClient.db(env.mongo.db);
}

const getState = async () =>
  (await coll('sync_state').findOne({ _id: 'sync-state' })) ?? {
    _id: 'sync-state',
    auditSeq: 0,
    lastPushAt: null,
    pushCount: 0,
  };

const saveState = async (state) =>
  coll('sync_state').updateOne({ _id: 'sync-state' }, { $set: state }, { upsert: true });

/**
 * Full mirror push. Safe to call manually (POST /api/sync/push) or on the
 * interval; guarded so two pushes never overlap.
 */
export async function pushOnce() {
  if (running) return { skipped: true, reason: 'push already running' };
  if (!syncConfigured()) {
    return { skipped: true, reason: 'SYNC_ENABLED=0 / ATLAS_URL empty / READONLY instance' };
  }
  running = true;
  const t0 = Date.now();
  const result = { at: nowIso(), collections: {}, audit: null, errors: [] };

  try {
    const atlas = await getAtlas();
    const state = await getState();

    /* ---------------- business collections: full mirror ---------------- */
    for (const name of MIRROR) {
      try {
        const localDocs = await coll(name).find({}).toArray();
        const localUuids = new Set(localDocs.map((d) => d.uuid).filter(Boolean));

        // stale rows on Atlas = hard deletes / resets locally
        const remoteUuids = await atlas
          .collection(name)
          .find({}, { projection: { uuid: 1 } })
          .toArray();
        const stale = remoteUuids
          .map((r) => r.uuid)
          .filter((u) => u && !localUuids.has(u));

        const ops = [
          ...localDocs.map((d) => {
            const { _id, ...rest } = d; // remote keeps its own _id; uuid is the key
            return { replaceOne: { filter: { uuid: rest.uuid }, replacement: rest, upsert: true } };
          }),
          ...stale.map((u) => ({ deleteOne: { filter: { uuid: u } } })),
        ];

        let touched = 0;
        for (let i = 0; i < ops.length; i += CHUNK) {
          const out = await atlas.collection(name).bulkWrite(ops.slice(i, i + CHUNK), {
            ordered: false,
          });
          touched += (out.upsertedCount ?? 0) + (out.modifiedCount ?? 0) + (out.deletedCount ?? 0);
        }

        try {
          await atlas.collection(name).createIndex({ uuid: 1 }, { unique: true });
        } catch {
          /* index exists with other options — cosmetic only */
        }

        result.collections[name] = { pushed: localDocs.length, staleRemoved: stale.length, touched };
      } catch (err) {
        result.errors.push(`${name}: ${err.message}`);
        result.collections[name] = { error: err.message };
      }
    }

    /* ------------------------- audit_log: seq tail ---------------------- */
    try {
      const cursor = Number(state.auditSeq) || 0;
      const tail = await coll('audit_log').find({ seq: { $gt: cursor } }).sort({ seq: 1 }).toArray();
      if (tail.length) {
        const last = tail[tail.length - 1].seq;
        // idempotent retry after a partial failure: re-claim the tail range
        await atlas.collection('audit_log').deleteMany({ seq: { $gt: cursor } });
        await atlas
          .collection('audit_log')
          .insertMany(tail.map(({ _id, ...rest }) => rest), { ordered: false });
        await atlas.collection('audit_log').createIndex({ seq: 1 }, { unique: true });
        state.auditSeq = last;
      }
      result.audit = { pushed: tail.length, cursor: state.auditSeq };
    } catch (err) {
      result.errors.push(`audit_log: ${err.message}`);
      result.audit = { error: err.message };
    }

    /* ------------------------------ state ------------------------------- */
    state.lastPushAt = result.at;
    state.pushCount = (Number(state.pushCount) || 0) + 1;
    state.lastError = result.errors.length ? result.errors.join('; ') : '';
    await saveState(state);

    result.durationMs = Date.now() - t0;
    result.ok = result.errors.length === 0;
    return result;
  } catch (err) {
    result.ok = false;
    result.errors.push(err.message);
    result.durationMs = Date.now() - t0;
    return result;
  } finally {
    running = false;
  }
}

export async function getSyncStatus() {
  const state = await getState();
  return {
    configured: syncConfigured(),
    enabled: Boolean(env.syncEnabled),
    atlasTarget: env.atlasUrl ? env.atlasUrl.replace(/\/\/[^@]*@/, '//***@') : '',
    lastPushAt: state.lastPushAt ?? null,
    pushCount: Number(state.pushCount) || 0,
    auditCursor: Number(state.auditSeq) || 0,
    lastError: state.lastError || '',
    intervalMin: env.syncIntervalMin,
  };
}

/** Called from index.js — no-op unless SYNC_ENABLED + ATLAS_URL (and not READONLY). */
export function startSyncLoop() {
  if (!syncConfigured()) {
    if (env.syncEnabled && !env.atlasUrl) {
      console.warn('[sync] SYNC_ENABLED=1 but ATLAS_URL is empty — push sync disabled');
    }
    return null;
  }
  const ms = Math.max(1, Number(env.syncIntervalMin) || 30) * 60_000;
  console.log(`[sync] push loop armed → Atlas every ${Math.round(ms / 60_000)} min`);
  const timer = setInterval(async () => {
    const r = await pushOnce();
    if (r.skipped) return;
    console.log(
      `[sync] ${r.ok ? 'pushed' : 'PUSH ERRORS'} in ${r.durationMs}ms` +
        (r.errors.length ? ` — ${r.errors.join('; ')}` : '')
    );
  }, ms);
  timer.unref();
  return timer;
}
