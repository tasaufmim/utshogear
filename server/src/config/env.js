/**
 * Centralised, validated environment configuration.
 * Fail fast at boot rather than at the first request.
 */
import { config as loadDotenv } from './dotenv-lite.js';

loadDotenv();

const bool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : v === '1' || v === 'true' || v === 'yes';

const int = (v, dflt) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

const missing = [];
function req(name, value) {
  if (!value) missing.push(name);
  return value;
}
function envSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if ((process.env.NODE_ENV || 'development') === 'production') {
    req('JWT_SECRET', process.env.JWT_SECRET);
    return '';
  }
  // Deterministic dev-only secret so local logins work out of the box.
  return 'dev-only-insecure-secret-do-not-use-in-production';
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, 4000),

  mongo: {
    url: req('MONGO_URL', process.env.MONGO_URL),
    db: process.env.MONGO_DB || 'utsho_gear',
    appUser: process.env.MONGO_APP_USER || 'utsho_app',
    appPass: process.env.MONGO_APP_PASS || '',
  },

  auth: {
    jwtSecret: envSecret(),
    jwtTtlHours: int(process.env.JWT_TTL_HOURS, 12),
    idleLockMinutes: int(process.env.IDLE_LOCK_MINUTES, 5),
    maxFailedLogins: 5,
    lockoutMinutes: 10,
  },

  /** READONLY mode: the owner's remote view. Every write is rejected with 403. */
  readonly: bool(process.env.READONLY, false),

  syncEnabled: bool(process.env.SYNC_ENABLED, false),
  atlasUrl: process.env.ATLAS_URL || '',
  syncIntervalMin: int(process.env.SYNC_INTERVAL_MIN, 30),

  businessTz: process.env.BUSINESS_TZ || 'Asia/Dhaka',
};

if (missing.length) {
  console.error(`[config] Missing required env var(s): ${missing.join(', ')}`);
  console.error('[config] Copy .env.example to .env and fill it in.');
  process.exit(1);
}
