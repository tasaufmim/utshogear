#!/usr/bin/env node
/**
 * Backup — mongodump of the whole shop DB into ./backups/<timestamp>/.
 *
 *   npm run backup                 full backup (gzip)
 *   npm run backup -- --keep 14    keep only the newest 14 backups
 *
 * The API may keep running: mongodump is consistent per-collection, and this
 * shop's ledgers are append-only, so a snapshot taken mid-day is still a
 * valid point-in-time copy of everything committed up to the dump.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// tiny inline .env loader (no dependency needed at the repo root)
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DB = process.env.MONGO_DB || 'utsho_gear';
// prefer the privileged admin (created by mongo:rs-init) for dump/restore;
// fall back to the restricted app user (it has find + listCollections)
const ADMIN_USER = process.env.MONGO_ADMIN_USER || '';
const USER = ADMIN_USER || process.env.MONGO_APP_USER || 'utsho_app';
const PASS = ADMIN_USER ? process.env.MONGO_ADMIN_PASS || '' : process.env.MONGO_APP_PASS || '';
const AUTH_DB = ADMIN_USER ? 'admin' : DB;
const URI = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';

const backupsDir = join(root, 'backups');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const outDir = join(backupsDir, `utsho-${stamp}`);

// keep flag
const keepIdx = process.argv.indexOf('--keep');
const keep = keepIdx > -1 ? Number(process.argv[keepIdx + 1]) : 0;

try {
  mkdirSync(outDir, { recursive: true });

  console.log(`[backup] dumping ${DB} → ${outDir}`);
  execFileSync(
    'mongodump',
    [
      `--uri=${URI}`,
      `--username=${USER}`,
      `--password=${PASS}`,
      `--authenticationDatabase=${AUTH_DB}`,
      `--db=${DB}`,
      '--gzip',
      `--archive=${join(outDir, 'dump.archive.gz')}`,
    ],
    { stdio: 'inherit' }
  );

  console.log('[backup] ✅ done:', outDir);

  // prune old backups
  if (keep > 0 && existsSync(backupsDir)) {
    const dirs = readdirSync(backupsDir)
      .filter((d) => d.startsWith('utsho-'))
      .map((d) => ({ d, t: statSync(join(backupsDir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    for (const old of dirs.slice(keep)) {
      rmSync(join(backupsDir, old.d), { recursive: true, force: true });
      console.log('[backup] pruned', old.d);
    }
  }
  process.exit(0);
} catch (err) {
  console.error('[backup] ❌ failed:', err.message);
  process.exit(1);
}
