import { env } from '../config/env.js';
import { forbidden } from '../lib/errors.js';

/**
 * READONLY mode = the owner's remote view.
 * The cloud mirror never accepts writes; every mutating verb is rejected
 * with a stable code the client can show as "read-only view".
 *
 * The only writes allowed are the session endpoints — otherwise the owner
 * could not sign in to look at anything.
 */
const ALLOWED_PATHS = new Set(['/api/auth/login', '/api/auth/unlock', '/api/auth/session']);

export function readonlyGuard(req, _res, next) {
  if (!env.readonly) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (ALLOWED_PATHS.has(req.path)) return next();
  return next(forbidden('This deployment is read-only', 'READONLY_MODE'));
}
