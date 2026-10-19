import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/Settings.js';
import { env } from '../config/env.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { AppError, unauthorized, forbidden, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';

const ROUNDS = 10;

export const hashPin = (pin) => bcrypt.hash(String(pin), ROUNDS);
export const verifyPin = (pin, hash) => bcrypt.compare(String(pin), hash);

function signToken(user) {
  return jwt.sign(
    { sub: user.uuid, role: user.role, name: user.name, phone: user.phone, mustChangePin: !!user.mustChangePin },
    env.auth.jwtSecret,
    { expiresIn: `${env.auth.jwtTtlHours}h` }
  );
}

function publicUser(user) {
  return {
    uuid: user.uuid,
    name: user.name,
    phone: user.phone,
    role: user.role,
    mustChangePin: !!user.mustChangePin,
    active: !!user.active,
  };
}

/** POST /api/auth/login */
export async function login({ phone, pin }, actorCtx) {
  const user = await User.findOne({ phone: String(phone).trim(), deletedAt: null });

  if (!user || !user.active) {
    await AuditRepo.log({
      action: 'auth.login_failed',
      entity: 'user',
      entityId: phone,
      meta: { reason: 'unknown_or_inactive' },
      actor: { userId: null, name: phone, role: 'guest' },
    });
    throw unauthorized('Invalid phone or PIN');
  }

  // lockout check
  if (user.lockUntil && new Date(user.lockUntil) > new Date()) {
    await AuditRepo.log({
      action: 'auth.login_blocked',
      entity: 'user',
      entityId: user.uuid,
      meta: { lockedUntil: user.lockUntil },
      actor: { userId: user.uuid, name: user.name, role: user.role },
    });
    throw forbidden(
      `Too many attempts — locked until ${user.lockUntil.slice(0, 16).replace('T', ' ')} UTC`,
      'LOCKED'
    );
  }

  const ok = await verifyPin(pin, user.pinHash);

  if (!ok) {
    const failed = (user.failedLogins || 0) + 1;
    const patch = { failedLogins: failed };
    if (failed >= env.auth.maxFailedLogins) {
      patch.lockUntil = new Date(Date.now() + env.auth.lockoutMinutes * 60_000).toISOString();
      patch.failedLogins = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: patch });
    await AuditRepo.log({
      action: 'auth.login_failed',
      entity: 'user',
      entityId: user.uuid,
      meta: { attempt: failed, locked: !!patch.lockUntil },
      actor: { userId: user.uuid, name: user.name, role: user.role },
    });
    throw unauthorized('Invalid phone or PIN');
  }

  // success
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: nowIso() } }
  );
  await AuditRepo.log({
    action: 'auth.login',
    entity: 'user',
    entityId: user.uuid,
    meta: { mode: actorCtx?.readonly ? 'remote-ro' : 'local' },
    actor: { userId: user.uuid, name: user.name, role: user.role },
  });

  return { token: signToken(user), user: publicUser(user) };
}

/** POST /api/auth/unlock — re-validate PIN to dismiss the idle lock overlay.
 *  Identity comes from the still-valid session token (the lock is not a
 *  logout), so this works even after a page reload where /auth/session
 *  carries no phone number. */
export async function unlock({ pin, userId }) {
  const user = await User.findOne({ uuid: userId, deletedAt: null });
  if (!user || !user.active || !(await verifyPin(pin, user.pinHash))) {
    throw unauthorized('Incorrect PIN');
  }
  return { ok: true, user: publicUser(user) };
}

/** POST /api/auth/change-pin */
export async function changePin({ phone, oldPin, newPin }, actor) {
  const user = await User.findOne({ phone: String(phone).trim(), deletedAt: null });
  if (!user) throw notFound('User not found');
  if (!(await verifyPin(oldPin, user.pinHash))) throw unauthorized('Current PIN is incorrect');

  const newPinStr = String(newPin);
  if (!/^\d{4,6}$/.test(newPinStr)) {
    throw new AppError(422, 'VALIDATION', 'PIN must be 4 to 6 digits');
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { pinHash: await hashPin(newPinStr), mustChangePin: false } }
  );
  await AuditRepo.log({
    action: 'auth.pin_changed',
    entity: 'user',
    entityId: user.uuid,
    before: { pinHash: '***' },
    after: { pinHash: '***' },
    actor,
  });
  return { ok: true };
}

/** Owner-PIN gate helper used by middleware for void/refund/discount overrides. */
export async function verifyOwnerPin(pin) {
  const owner = await User.findOne({ role: 'owner', active: true, deletedAt: null });
  if (!owner) return false;
  const ok = await verifyPin(pin, owner.pinHash);
  await AuditRepo.log({
    action: ok ? 'auth.owner_pin_ok' : 'auth.owner_pin_failed',
    entity: 'user',
    entityId: owner.uuid,
    actor: { userId: owner.uuid, name: owner.name, role: 'owner' },
  });
  return ok;
}
