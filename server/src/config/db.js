import mongoose from 'mongoose';
import { env } from './env.js';

let connected = false;

export async function connectMongo({ retries = 12, delayMs = 1500 } = {}) {
  mongoose.set('strictQuery', true);

  const opts = {
    dbName: env.mongo.db,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    // Transactions require the replica set; surface a clear error if it is missing.
  };
  if (env.mongo.appPass) {
    opts.auth = { username: env.mongo.appUser, password: env.mongo.appPass };
    // Talk to the business DB with this user (roles are scoped per database).
    opts.authSource = env.mongo.db;
  }

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(env.mongo.url, opts);
      connected = true;

      if (!env.isProd) {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        const setName = hello.setName;
        if (!setName) {
          console.warn(
            '[db] WARNING: mongod is NOT running as a replica set. Transactions will fail.\n' +
              '      Run: npm run mongo:start && npm run mongo:rs-init'
          );
        } else {
          console.log(`[db] connected db=${env.mongo.db} replSet=${setName}`);
        }
      }
      return mongoose.connection;
    } catch (err) {
      lastErr = err;
      console.warn(`[db] connect attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error('[db] could not connect to MongoDB:', lastErr?.message);
  console.error('[db] start it with: npm run mongo:start && npm run mongo:rs-init');
  process.exit(1);
}

export const db = () => {
  if (!connected) throw new Error('MongoDB not connected yet');
  return mongoose.connection;
};

/** Raw collection accessor (audit_log uses this — insert/find only, see AuditRepo). */
export const coll = (name) => mongoose.connection.collection(name);

/**
 * Run `fn(session)` inside a MongoDB multi-document transaction.
 * Requires a replica set (guaranteed by scripts/mongo-start.sh).
 * Retries transient transaction errors once, per driver guidance.
 */
export async function withTxn(fn, { session: outer } = {}) {
  if (outer) return fn(outer); // already inside a transaction
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    session.endSession();
  }
}

export async function pingMongo() {
  const t0 = Date.now();
  await mongoose.connection.db.admin().command({ ping: 1 });
  return Date.now() - t0;
}
