#!/usr/bin/env node
/**
 * Restore — puts a backup archive back into Mongo (replaces current data).
 *
 *   npm run restore -- --list           show available backups
 *   npm run restore -- utsho-2026-...   restore that snapshot (asks y/N)
 *   npm run restore -- latest --yes     restore newest, no prompt
 *
 * ⚠️  DROPS the current database content first so the restored state is
 * byte-identical to the snapshot. Stop the API before restoring.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

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
// prefer the privileged admin (created by mongo:rs-init); app user as fallback
const ADMIN_USER = process.env.MONGO_ADMIN_USER || '';
const USER = ADMIN_USER || process.env.MONGO_APP_USER || 'utsho_app';
const PASS = ADMIN_USER ? process.env.MONGO_ADMIN_PASS || '' : process.env.MONGO_APP_PASS || '';
const AUTH_DB = ADMIN_USER ? 'admin' : DB;
const URI = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const backupsDir = join(root, 'backups');

const args = process.argv.slice(2).filter((a) => a !== '--yes');
const yes = process.argv.includes('--yes');

function listBackups() {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((d) => d.startsWith('utsho-'))
    .map((d) => ({ name: d, t: statSync(join(backupsDir, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
}

const available = listBackups();

if (args.includes('--list') || available.length === 0) {
  if (available.length === 0) console.log('[restore] no backups found in ./backups');
  for (const b of available) console.log(' ', b.name, new Date(b.t).toLocaleString());
  process.exit(0);
}

let target = args[0];
if (target === 'latest') target = available[0].name;

const archive = join(backupsDir, target, 'dump.archive.gz');
if (!existsSync(archive)) {
  console.error(`[restore] ❌ no archive at ${archive}`);
  console.error('available:', available.map((b) => b.name).join(', '));
  process.exit(1);
}

async function run() {
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `[restore] This REPLACES database "${DB}" with ${target}. Type RESTORE to continue: `
    );
    rl.close();
    if (answer.trim() !== 'RESTORE') {
      console.log('[restore] cancelled');
      process.exit(0);
    }
  }

  console.log(`[restore] restoring ${target} → ${DB} (drop=true)`);
  execFileSync(
    'mongorestore',
    [
      `--uri=${URI}`,
      `--username=${USER}`,
      `--password=${PASS}`,
      `--authenticationDatabase=${AUTH_DB}`,
      `--nsInclude=${DB}.*`,
      '--drop',
      '--gzip',
      `--archive=${archive}`,
    ],
    { stdio: 'inherit' }
  );
  console.log('[restore] ✅ done — restart the API and run `npm run mongo:verify-roles` + `npm run audit:verify`');
  process.exit(0);
}

run().catch((err) => {
  console.error('[restore] ❌ failed:', err.message);
  process.exit(1);
});
