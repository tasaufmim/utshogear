#!/usr/bin/env node
/**
 * Audit verify — re-walks the whole hash chain of audit_log from seq 1 and
 * proves every entry's hash matches its content AND its predecessor.
 *
 *   npm run audit:verify
 *
 * Runs as the app user (find-only on audit_log) — the same code path the
 * owner UI's "Verify chain" button uses, so there is exactly one
 * implementation of what "intact" means.
 */
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

const { connectMongo } = await import('../server/src/config/db.js');
const { AuditRepo } = await import('../server/src/repos/AuditRepo.js');

await connectMongo({ retries: 4, delayMs: 800 });
const result = await AuditRepo.verify();

if (result.intact) {
  console.log(`✅ audit chain intact — ${result.count} entries verified`);
  process.exit(0);
} else {
  console.log(`❌ BROKEN at seq #${result.brokenAt} — treat the database as compromised and restore from backup`);
  process.exit(1);
}
