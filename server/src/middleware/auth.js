import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/** Validate bearer token → req.user = { userId, role, name }. */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, env.auth.jwtSecret);
    req.user = {
      userId: payload.sub,
      role: payload.role,
      name: payload.name,
      phone: payload.phone || undefined, // carried since login (session-restore display)
      mustChangePin: !!payload.mustChangePin,
    };
    return next();
  } catch {
    return next(unauthorized('Session expired — please sign in again'));
  }
}

/** requireRole('owner') or requireRole('owner','cashier') */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${roles.join(' or ')}`, 'ROLE_REQUIRED'));
    }
    return next();
  };
}

export const requireOwner = requireRole('owner');

/** Owner PIN gate for sensitive actions (void, refund, below-floor price, big discounts). */
export function ownerPin(pins) {
  return (req, _res, next) => {
    if (req.user?.role === 'owner') return next(); // owner acting as self
    const supplied = req.get('x-owner-pin');
    if (!supplied) return next(forbidden('Owner PIN required', 'OWNER_PIN_REQUIRED'));
    return pins.verifyOwnerPin(supplied).then((ok) => {
      if (!ok) return next(forbidden('Incorrect owner PIN', 'OWNER_PIN_INVALID'));
      return next();
    }, next);
  };
}

/**
 * Field-level secrecy for cashiers.
 * Cost/margin data must never even appear in a cashier's response payload —
 * this runs server-side, not in CSS.
 */
const COST_FIELDS = [
  'avgCost',
  'costPrice',
  'lastPurchasePrice',
  'floorPrice',
  'defaultMarginPct',
  'lineProfit',
  'unitCost',
  'cogs',
  'cogsCents',
  'profitCents',
  'profitAmt',
  'stockValue',
  'stockValueCents',
];

const OWNER_ONLY_REPORT_KEYS = ['cogs', 'profit', 'marginAmt', 'marginPct', 'stockValue'];

function deepStrip(value) {
  if (Array.isArray(value)) return value.map(deepStrip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (COST_FIELDS.includes(k)) continue;
      out[k] = deepStrip(v);
    }
    return out;
  }
  return value;
}

/**
 * Usage:  return res.json(stripFor(req.user.role, { data: products }))
 * Cashier ⇒ cost fields removed everywhere (docs, nested arrays, embedded sale lines).
 */
export function stripFor(role, payload) {
  if (role === 'owner') return payload;
  if (payload && typeof payload === 'object') {
    const clone = deepStrip(payload);
    // Top-level report objects: drop owner-only keys too.
    if (clone.meta) {
      for (const key of OWNER_ONLY_REPORT_KEYS) delete clone.meta[key];
    }
    return clone;
  }
  return payload;
}

export const canViewCost = (req) => req.user?.role === 'owner';
