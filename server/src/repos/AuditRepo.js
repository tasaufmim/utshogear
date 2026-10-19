/**
 * IMMUTABLE AUDIT LOG — the tamper-evident spine of the system.
 *
 * Three independent guarantees:
 *  1. This module exposes ONLY log() / find() / verify(). No update, no delete.
 *  2. The Mongo user the app connects with has find+insert ONLY on audit_log
 *     (granted by scripts/rs-init.mjs) — so an app bug, a compromised process
 *     or even a stray shell command CANNOT rewrite history at the DB level.
 *  3. Every entry carries hash = sha256(prevHash + canonical(entry)).
 *     verify() walks the chain and reports the first broken link, if any.
 *
 * Entries are append-only, therefore sync-safe (Phase 10 push is insert-if-missing).
 */
import { createHash } from 'node:crypto';
import { coll, withTxn } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';

const COLLECTION = 'audit_log';
const GENESIS = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively so hashes are stable. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function entryHash(prevHash, entry) {
  return createHash('sha256').update(prevHash + canonical(entry)).update('utf8').digest('hex');
}

async function nextSeq(session) {
  const counters = coll('counters');
  const doc = await counters.findOneAndUpdate(
    { _id: 'audit_log' },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', session, upsert: true }
  );
  return doc.value?.seq ?? doc.seq ?? 1;
}

async function lastEntry(session) {
  return coll(COLLECTION).findOne({}, { sort: { seq: -1 }, session });
}

/**
 * Append one audit entry. Call this INSIDE the business transaction so that
 * "the write happened" and "the log says it happened" share one commit.
 *
 * @param {object} e
 * @param {string} e.action     e.g. 'sale.void', 'product.price_change'
 * @param {string} e.entity     e.g. 'sale', 'product'
 * @param {string} e.entityId   uuid of the entity
 * @param {object} [e.before]   snapshot before (omit for creates)
 * @param {object} [e.after]    snapshot after  (omit for deletes)
 * @param {object} [e.actor]    { userId, name, role }
 * @param {object} [e.meta]     free-form extras (reason, receiptNo, …)
 * @param {ClientSession} [e.session]
 */
export async function log({ action, entity, entityId, before, after, actor, meta, session }) {
  if (!action || !entity) throw new Error('audit.log requires action and entity');

  return withTxn(
    async (s) => {
      const prev = await lastEntry(s);
      const prevHash = prev?.hash ?? GENESIS;
      const seq = await nextSeq(s);

      const entry = {
        seq,
        uuid: uuid(),
        at: nowIso(),
        actorId: actor?.userId ?? null,
        actorName: actor?.name ?? 'system',
        actorRole: actor?.role ?? 'system',
        action,
        entity,
        entityId: entityId ?? null,
        before: before ?? null,
        after: after ?? null,
        meta: meta ?? null,
        prevHash,
      };
      entry.hash = entryHash(prevHash, entry);

      await coll(COLLECTION).insertOne(entry, { session: s });
      return entry;
    },
    { session }
  );
}

/**
 * Read-only query. `find` is the only other operation the DB role allows.
 * @param {object} filter  { from, to, actorId, entity, action, entityId }
 * @param {object} page    { skip, limit }
 */
export async function find(filter = {}, page = {}) {
  const q = {};
  if (filter.actorId) q.actorId = filter.actorId;
  if (filter.entity) q.entity = filter.entity;
  if (filter.action) q.action = filter.action;
  if (filter.entityId) q.entityId = filter.entityId;
  if (filter.from || filter.to) {
    q.at = {};
    if (filter.from) q.at.$gte = filter.from;
    if (filter.to) q.at.$lte = filter.to;
  }
  const limit = Math.min(Math.max(Number(page.limit) || 50, 1), 200);
  const skip = Math.max(Number(page.skip) || 0, 0);

  const [items, total] = await Promise.all([
    coll(COLLECTION)
      .find(q)
      .sort({ seq: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    coll(COLLECTION).countDocuments(q),
  ]);
  return { items, total, skip, limit };
}

/**
 * Recompute the whole chain. Returns { count, intact, brokenAt? }.
 * O(n) over the log — fine for an owner pressing "Verify".
 */
export async function verify() {
  let prevHash = GENESIS;
  let count = 0;
  const cursor = coll(COLLECTION)
    // only `_id` is excluded — log() hashes the entry before Mongo assigns _id
    .find({}, { projection: { _id: 0 } })
    .sort({ seq: 1 });

  for await (const doc of cursor) {
    count++;
    // hash was computed over the entry BEFORE the hash field existed — strip
    // it (and _id) before recomputing, but keep it for the comparison below.
    const { hash, _id, ...entry } = doc;
    const expected = entryHash(prevHash, entry);
    if (doc.seq !== count) {
      return { count, intact: false, brokenAt: doc.seq, reason: 'sequence_gap' };
    }
    if (doc.prevHash !== prevHash) {
      return { count, intact: false, brokenAt: doc.seq, reason: 'prev_hash_mismatch' };
    }
    if (hash !== expected) {
      return { count, intact: false, brokenAt: doc.seq, reason: 'hash_mismatch' };
    }
    prevHash = hash;
  }
  return { count, intact: true };
}

/** CSV export (owner only). */
async function toCsv(filter) {
  const { items } = await find({ ...filter, }, { limit: 200, skip: 0 });
  const head = 'seq,at,actor,role,action,entity,entityId,summary';
  const rows = items.map((e) => {
    const summary = [
      e.before ? 'before:' + compact(e.before) : '',
      e.after ? 'after:' + compact(e.after) : '',
      e.meta ? 'meta:' + compact(e.meta) : '',
    ]
      .filter(Boolean)
      .join(' | ')
      .replace(/"/g, "'")
      .replace(/\n/g, ' ');
    return [e.seq, e.at, e.actorName, e.actorRole, e.action, e.entity, e.entityId ?? '', `"${summary}"`].join(',');
  });
  return [head, ...rows].join('\n');
}

function compact(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length > 300 ? s.slice(0, 297) + '...' : s;
  } catch {
    return '';
  }
}

export const AuditRepo = { log, find, verify, toCsv };

/** The audit collection name (used by scripts and tests). */
export const AUDIT_COLLECTION = COLLECTION;
