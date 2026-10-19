/**
 * Proves the immutability guarantees actually hold at the DATABASE level.
 *
 *   npm run mongo:verify-roles
 *
 * Checks, using the restricted app credentials (not admin):
 *   1. app user CAN insert into audit_log
 *   2. app user CANNOT update audit_log     ← the core guarantee
 *   3. app user CANNOT remove from audit_log
 *   4. app user CAN update a business collection (e.g. settings)
 *   5. replica set is up (transactions possible)
 *
 * Exit code 0 = all guarantees hold; 1 = something is broken.
 */
import { MongoClient } from 'mongodb';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !(t.slice(0, i).trim() in process.env)) {
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
}

const DB = process.env.MONGO_DB || 'utsho_gear';
const APP_USER = process.env.MONGO_APP_USER || 'utsho_app';
const APP_PASS = process.env.MONGO_APP_PASS || 'utsho-local-app-pass';

// Connect AS THE APP USER against the business database.
const appUrl = `mongodb://${encodeURIComponent(APP_USER)}:${encodeURIComponent(APP_PASS)}@127.0.0.1:27017/${DB}?authSource=${DB}&replicaSet=rs0`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const client = new MongoClient(appUrl);
try {
  await client.connect();
  const db = client.db(DB);
  const audit = db.collection('audit_log');
  const settings = db.collection('settings');

  // 1. replica set
  const hello = await db.admin().command({ hello: 1 }).catch((e) => ({ setName: null, err: e.message }));
  check('replica set active (transactions available)', !!hello.setName, hello.setName || hello.err || 'no setName');

  // 2. insert allowed
  const probe = {
    seq: 999999999,
    uuid: '00000000-0000-4000-8000-000000000000',
    hash: 'f'.repeat(64),
    prevHash: '0'.repeat(64),
    at: new Date().toISOString(),
    actorId: null,
    actorName: 'role-probe',
    actorRole: 'system',
    action: 'system.role_probe',
    entity: 'system',
    entityId: 'role-probe',
    before: null,
    after: null,
    meta: { purpose: 'verify-roles' },
  };
  let canInsert = false;
  // Insert the probe inside a transaction and ABORT it: this still proves the
  // app user CAN insert (authorization is checked at insert time), but leaves
  // no row behind — a stray probe row would break the audit hash chain and
  // could never be removed (the role has no remove privilege, by design).
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await audit.insertOne(probe, { session });
      // abort: never commit
      throw new Error('__abort_probe__');
    });
  } catch (e) {
    if (e.message === '__abort_probe__') {
      canInsert = true; // insert itself succeeded; only the commit was skipped
    } else {
      check('app user CAN insert into audit_log', false, e.message);
    }
  } finally {
    await session.endSession();
  }
  if (canInsert) check('app user CAN insert into audit_log', true, 'via aborted txn (no row persisted)');

  // 3. update must FAIL
  let updateBlocked = false;
  try {
    await audit.updateOne({ uuid: probe.uuid }, { $set: { action: 'TAMPERED' } });
  } catch (e) {
    updateBlocked = true;
    check('audit_log UPDATE is BLOCKED', true, e.codeName || e.message.slice(0, 60));
  }
  if (!updateBlocked) check('audit_log UPDATE is BLOCKED', false, 'update succeeded — IMMUTABILITY BROKEN');

  // 4. delete must FAIL
  let deleteBlocked = false;
  try {
    await audit.deleteOne({ uuid: probe.uuid });
  } catch (e) {
    deleteBlocked = true;
    check('audit_log DELETE is BLOCKED', true, e.codeName || e.message.slice(0, 60));
  }
  if (!deleteBlocked) check('audit_log DELETE is BLOCKED', false, 'delete succeeded — IMMUTABILITY BROKEN');

  // 4b. no probe row was persisted (aborted txn above), so the audit chain
  // stays clean and intact for AuditRepo.verify().

  // 5. business collection still writable
  try {
    await settings.updateOne({ _id: { $exists: true } }, { $set: { _roleProbeAt: new Date().toISOString() } });
    check('app user CAN update business collections', true);
  } catch (e) {
    check('app user CAN update business collections', false, e.message);
  }

  console.log(failures === 0 ? '\n✅ ALL GUARANTEES HOLD' : `\n❌ ${failures} GUARANTEE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  await client.close().catch(() => {});
}
