#!/usr/bin/env node
/**
 * Stock reconcile — verifies the invariant
 *
 *     products.stock === SUM(stock_moves.qty)     for every product
 *
 *   npm run reconcile            report mismatches (read-only)
 *   npm run reconcile -- --fix   repair the cached products.stock from the
 *                                append-only ledger (stock_moves is truth)
 *
 * The ledger is append-only and never rewritten, so the cache can always be
 * rebuilt from it. --fix prints every change it makes; for audited manual
 * corrections use Inventory → Adjust inside the app instead.
 */
import { MongoClient } from 'mongodb';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DB = process.env.MONGO_DB || 'utsho_gear';
const USER = process.env.MONGO_APP_USER || 'utsho_app';
const PASS = process.env.MONGO_APP_PASS || '';
const URI = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';

const fix = process.argv.includes('--fix');

const client = new MongoClient(URI, { auth: { username: USER, password: PASS }, authSource: DB });

try {
  await client.connect();
  const db = client.db(DB);

  const sums = await db
    .collection('stock_moves')
    .aggregate([{ $group: { _id: '$productId', total: { $sum: '$qty' } } }])
    .toArray();
  const ledger = Object.fromEntries(sums.map((s) => [s._id, s.total]));

  const products = await db
    .collection('products')
    .find({ deletedAt: null })
    .project({ uuid: 1, name: 1, sku: 1, stock: 1 })
    .toArray();

  const mismatches = products
    .map((p) => ({ ...p, ledger: ledger[p.uuid] ?? 0 }))
    .filter((p) => p.stock !== p.ledger);

  if (mismatches.length === 0) {
    console.log(`✅ reconcile OK — ${products.length} products, cache matches ledger everywhere`);
    process.exit(0);
  }

  console.log(`⚠️  ${mismatches.length} mismatch(es) of ${products.length} products:\n`);
  for (const m of mismatches) {
    console.log(`  ${m.sku.padEnd(24)} ${m.name.slice(0, 32).padEnd(34)} cache=${String(m.stock).padStart(5)}  ledger=${String(m.ledger).padStart(5)}  diff=${m.ledger - m.stock}`);
  }

  if (!fix) {
    console.log('\nRun `npm run reconcile -- --fix` to rebuild the cache from the ledger.');
    process.exit(1);
  }

  console.log('\n[fix] repairing cached stock from ledger…');
  for (const m of mismatches) {
    await db.collection('products').updateOne({ uuid: m.uuid }, { $set: { stock: m.ledger } });
    console.log(`  fixed ${m.sku}: ${m.stock} → ${m.ledger}`);
  }
  console.log(`✅ repaired ${mismatches.length} product(s)`);
  process.exit(0);
} catch (err) {
  console.error('❌ reconcile failed:', err.message);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
