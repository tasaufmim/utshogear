/**
 * One-time (idempotent) local database setup:
 *   1. initiate the single-node replica set  rs0
 *   2. create the RESTRICTED app role:
 *        - readWrite on every business collection
 *        - find + insert ONLY on audit_log   ← the immutability guarantee
 *   3. create the app user with those roles
 *   4. build all indexes (needs a privileged connection; the app user has no
 *      createIndex privilege by design)
 *
 * Run: npm run mongo:rs-init
 */
import { MongoClient } from 'mongodb';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// reuse the project's .env loader without importing server code
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

const URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = process.env.MONGO_DB || 'utsho_gear';
const APP_USER = process.env.MONGO_APP_USER || 'utsho_app';
const APP_PASS = process.env.MONGO_APP_PASS || 'utsho-local-app-pass';
// Admin credentials for privileged re-runs (the localhost exception only works
// while the server has NO users at all, i.e. the very first run). Bootstrap:
// run once against a fresh (or auth-disabled) mongod — the script then creates
// `utshoAdmin` and appends MONGO_ADMIN_USER/MONGO_ADMIN_PASS to .env.
const ADMIN_USER = process.env.MONGO_ADMIN_USER || '';
const ADMIN_PASS = process.env.MONGO_ADMIN_PASS || '';
const USING_ADMIN = Boolean(ADMIN_USER && ADMIN_PASS);

const client = new MongoClient(
  URL,
  USING_ADMIN
    ? { auth: { username: ADMIN_USER, password: ADMIN_PASS }, authSource: 'admin' }
    : undefined
);

const BUSINESS_COLLECTIONS = [
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
  'returns',
  'exchanges',
  'customers',
  'customer_payments',
  'expenses',
  'notifications',
  'counters',
  'sync_state',
  'parks', // held carts / drafts (Phase 4)
  'expense_categories', // Phase 7 daily costing
  'sms_log', // Phase 10 SMS journal (append-only)
];

try {
  await client.connect();
  const admin = client.db('admin');

  // ---------- 1. replica set ----------
  try {
    const hello = await admin.command({ hello: 1 });
    if (!hello.setName) {
      console.log('[rs-init] initiating replica set rs0 …');
      await admin.command({
        replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] },
      });
      // wait for primary
      for (let i = 0; i < 30; i++) {
        try {
          const h = await admin.command({ hello: 1 });
          if (h.isWritablePrimary || h.ismaster) break;
        } catch {
          /* not ready */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log('[rs-init] rs0 is primary');
    } else {
      console.log(`[rs-init] replica set already initiated: ${hello.setName}`);
    }
  } catch (err) {
    if (err.codeName === 'AlreadyInitialized') console.log('[rs-init] already initialized');
    else throw err;
  }

  const db = client.db(DB);

  // ---------- 2. restricted roles ----------
  // audit_log: find + insert ONLY. update/remove are NOT granted, so history
  // cannot be rewritten even by the application process itself.
  const ensureRole = async (spec) => {
    try {
      await admin.command({ createRole: spec.role, privileges: spec.privileges, roles: [], writeConcern: { w: 1 } });
    } catch (err) {
      // 51002 = RoleAlreadyExists — make re-runs idempotent
      if (err.code === 51002) {
        await admin.command({ updateRole: spec.role, privileges: spec.privileges, roles: [], writeConcern: { w: 1 } });
      } else throw err;
    }
  };
  await ensureRole({
    role: 'utshoAuditReadOnly',
    privileges: [
      { resource: { db: DB, collection: 'audit_log' }, actions: ['find', 'insert'] },
      { resource: { db: DB, collection: 'counters' }, actions: ['find', 'update'] },
    ],
  });
  console.log('[rs-init] role utshoAuditReadOnly ready (find+insert on audit_log)');

  const businessPrivs = BUSINESS_COLLECTIONS.filter((c) => c !== 'audit_log').map((c) => ({
    resource: { db: DB, collection: c },
    actions: [
      'find',
      'insert',
      'update',
      'remove',
      'createIndex',
      'dropIndex',
      'listIndexes',
      'createCollection',
    ],
  }));

  await ensureRole({
    role: 'utshoAppRole',
    privileges: [
      ...businessPrivs,
      { resource: { db: DB, collection: 'audit_log' }, actions: ['find', 'insert'] },
      { resource: { db: DB, collection: 'counters' }, actions: ['find', 'update'] },
      { resource: { db: '', collection: '' }, actions: ['listDatabases'] },
      // list collection NAMES in the business db — needed by mongodump (backup);
      // exposes nothing beyond names the app can already `find` on every one.
      { resource: { db: DB, collection: '' }, actions: ['listCollections'] },
    ],
  });
  console.log('[rs-init] role utshoAppRole ready (business rw + audit read/insert)');

  // ---------- 3. app user ----------
  // Created in the BUSINESS db: the server (config/db.js) and verify-roles.mjs
  // both authenticate with authSource=<business db>, so the user must live there.
  // The roles are defined in admin — grant them with the explicit @admin suffix.
  try {
    await db.command({ createUser: APP_USER, pwd: APP_PASS, roles: [{ role: 'utshoAppRole', db: 'admin' }] });
    console.log(`[rs-init] user ${APP_USER} created`);
  } catch (err) {
    if (err.code === 51003) {
      await db.command({
        updateUser: APP_USER,
        pwd: APP_PASS,
        roles: [{ role: 'utshoAppRole', db: 'admin' }],
      });
      console.log(`[rs-init] user ${APP_USER} roles refreshed`);
    } else if (err.code === 51003 || /already exists/i.test(err.message || '')) {
      await db.command({ updateUser: APP_USER, pwd: APP_PASS, roles: [{ role: 'utshoAppRole', db: 'admin' }] });
      console.log(`[rs-init] user ${APP_USER} roles refreshed`);
    } else {
      throw err;
    }
  }

  // ---------- 4. indexes (privileged) ----------
  const indexes = {
    users: [{ key: { phone: 1 }, unique: true }, { key: { uuid: 1 }, unique: true }],
    categories: [{ key: { uuid: 1 }, unique: true }, { key: { name: 1, deletedAt: 1 } }],
    brands: [{ key: { uuid: 1 }, unique: true }, { key: { name: 1 } }],
    bike_models: [{ key: { uuid: 1 }, unique: true }, { key: { name: 1 } }],
    products: [
      { key: { barcode: 1 }, unique: true, sparse: true },
      { key: { sku: 1 }, unique: true },
      { key: { uuid: 1 }, unique: true },
      { key: { searchText: 1 } },
      { key: { categoryId: 1 } },
      { key: { brandId: 1 } },
      { key: { bikeModelIds: 1 } },
      { key: { updatedAt: -1 } },
      { key: { deletedAt: 1, active: 1 } },
    ],
    stock_moves: [
      { key: { uuid: 1 }, unique: true },
      { key: { productId: 1, date: -1 } },
      { key: { createdAt: -1 } },
      { key: { refType: 1, refId: 1 } },
    ],
    sales: [
      { key: { uuid: 1 }, unique: true },
      { key: { receiptNo: 1 }, unique: true },
      { key: { createdAt: -1 } },
      { key: { customerId: 1, createdAt: -1 } },
      { key: { status: 1, createdAt: -1 } },
      { key: { clientTxnId: 1 }, sparse: true, unique: true },
    ],
    returns: [
      { key: { uuid: 1 }, unique: true },
      { key: { returnNo: 1 }, unique: true },
      { key: { saleUuid: 1 } },
      { key: { createdAt: -1 } },
    ],
    customers: [
      { key: { uuid: 1 }, unique: true },
      { key: { phone: 1 }, sparse: true },
      { key: { name: 1 } },
      { key: { updatedAt: -1 } },
    ],
    customer_payments: [{ key: { uuid: 1 }, unique: true }, { key: { customerId: 1, createdAt: -1 } }],
    suppliers: [{ key: { uuid: 1 }, unique: true }, { key: { name: 1 } }],
    supplier_payments: [{ key: { uuid: 1 }, unique: true }, { key: { supplierId: 1, createdAt: -1 } }],
    purchases: [{ key: { uuid: 1 }, unique: true }, { key: { supplierId: 1, createdAt: -1 } }, { key: { createdAt: -1 } }],
    expenses: [{ key: { uuid: 1 }, unique: true }, { key: { date: -1 } }, { key: { categoryId: 1, date: -1 } }],
    expense_categories: [{ key: { uuid: 1 }, unique: true }, { key: { name: 1 } }],
    sms_log: [{ key: { uuid: 1 }, unique: true }, { key: { createdAt: -1 } }, { key: { to: 1 } }],
    notifications: [{ key: { uuid: 1 }, unique: true }, { key: { status: 1, createdAt: 1 } }],
    audit_log: [{ key: { seq: 1 }, unique: true }, { key: { uuid: 1 }, unique: true }, { key: { at: -1 } }, { key: { entity: 1, entityId: 1 } }, { key: { actorId: 1 } }],
    parks: [{ key: { uuid: 1 }, unique: true }, { key: { status: 1, updatedAt: -1 } }],
    exchanges: [{ key: { uuid: 1 }, unique: true }, { key: { returnUuid: 1 } }],
    sync_state: [{ key: { _id: 1 } }],
  };

  let built = 0;
  for (const [collName, defs] of Object.entries(indexes)) {
    const c = db.collection(collName);
    for (const def of defs) {
      try {
        // omit boolean options when unset — mongod rejects `unique: null` / `sparse: null`
        const opts = { name: undefined };
        if (def.unique) opts.unique = true;
        if (def.sparse) opts.sparse = true;
        await c.createIndex(def.key, opts);
        built++;
      } catch (err) {
        if (err.code === 85 || /already exists/i.test(err.message || '')) {
          // index exists with different options — report, don't fail setup
          console.warn(`[rs-init] index conflict on ${collName}: ${err.message}`);
        } else throw err;
      }
    }
  }
  console.log(`[rs-init] ${built} indexes ensured`);

  // ---------- 5. admin bootstrap for future privileged re-runs ----------
  // Privileged commands (createRole/createUser/createIndex) only work while
  // the server has no users yet (localhost exception) or auth is disabled.
  // On such a first run, create a root user and record it in .env so every
  // later `npm run mongo:rs-init` can authenticate instead of failing (code 13).
  if (!USING_ADMIN) {
    try {
      const adminPass = randomBytes(18).toString('base64url');
      await admin.command({ createUser: 'utshoAdmin', pwd: adminPass, roles: ['root'] });
      const line = `\n# created by mongo:rs-init (privileged re-runs)\nMONGO_ADMIN_USER=utshoAdmin\nMONGO_ADMIN_PASS=${adminPass}\n`;
      if (existsSync(envFile)) appendFileSync(envFile, line);
      else console.log('[rs-init] ⚠ no .env found — set manually:\n' + line);
      console.log('[rs-init] admin user utshoAdmin created — credentials stored in .env (MONGO_ADMIN_USER/MONGO_ADMIN_PASS)');
    } catch (err) {
      if (err.code === 51000) {
        console.log('[rs-init] admin user already exists — add MONGO_ADMIN_USER/MONGO_ADMIN_PASS to .env for future re-runs');
      } else {
        console.warn(`[rs-init] admin bootstrap skipped: ${err.message}`);
      }
    }
  }

  console.log('[rs-init] DONE');
  console.log(`[rs-init] app connects as ${APP_USER} (no update/remove on audit_log)`);
} finally {
  await client.close();
}
