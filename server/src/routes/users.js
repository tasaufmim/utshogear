/**
 * User management (owner only).
 *
 * PINs are bcrypt-hashed (never returned, never logged); every mutation —
 * including a user changing their own PIN — lands in the audit log.
 * Guards: you cannot deactivate yourself, and the last active owner cannot
 * be demoted or deactivated (the shop must never lose its owner).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { User } from '../models/Settings.js';
import { hashPin, verifyPin } from '../services/authService.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { conflict, notFound, validation, unauthorized, badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/dates.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const owner = requireRole('owner');
const PIN_RE = /^\d{4,6}$/;
const phoneRe = /^01\d{9}$/;

const safe = (u) => ({
  uuid: u.uuid,
  name: u.name,
  phone: u.phone,
  role: u.role,
  active: u.active,
  mustChangePin: u.mustChangePin,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt ?? null,
});

/* --------------------------------- LIST --------------------------------- */
usersRouter.get('/', owner, async (_req, res, next) => {
  try {
    const items = await User.find().select('-pinHash').sort({ role: 1, name: 1 }).lean();
    res.json({ data: items.map(safe) });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- CREATE -------------------------------- */
const createSchema = z.object({
  name: z.string().min(1).max(60),
  phone: z.string().regex(phoneRe, 'Bangladeshi mobile number, e.g. 017XXXXXXXX'),
  pin: z.string().regex(PIN_RE, 'PIN must be 4–6 digits'),
  role: z.enum(['owner', 'cashier']),
});

usersRouter.post('/', owner, async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);

    const dup = await User.findOne({ phone: body.phone }).lean();
    if (dup) throw conflict('A user with this phone already exists', { field: 'phone' });

    const doc = await User.create({
      name: body.name,
      phone: body.phone,
      role: body.role,
      pinHash: await hashPin(body.pin),
      mustChangePin: true, // first login forces a PIN change
      active: true,
      createdAt: nowIso(),
    });

    await AuditRepo.log({
      action: 'user.create',
      entity: 'user',
      entityId: doc.uuid,
      after: { name: doc.name, phone: doc.phone, role: doc.role },
      actor: req.user,
    });
    res.status(201).json({ data: safe(doc) });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- UPDATE -------------------------------- */
usersRouter.patch('/:id', owner, async (req, res, next) => {
  try {
    const doc = await User.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('User not found');

    const patch = z
      .object({
        name: z.string().min(1).max(60).optional(),
        role: z.enum(['owner', 'cashier']).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);

    // yourself?
    const isSelf = doc.uuid === req.user.userId;

    // Self-guards first — they are the more specific rule, and with a single
    // owner account they would otherwise be shadowed by the last-owner check.
    if (isSelf && patch.active === false) {
      throw badRequest('You cannot deactivate your own account');
    }
    if (isSelf && patch.role === 'cashier') {
      throw badRequest('You cannot demote yourself — ask another owner');
    }

    if (patch.active === false || (patch.role && patch.role !== doc.role)) {
      const owners = await User.countDocuments({ role: 'owner', active: true });
      if (doc.role === 'owner' && (patch.role === 'cashier' || patch.active === false) && owners <= 1) {
        throw conflict('This is the last active owner — promote another owner first', { owners });
      }
    }

    const after = await User.findOneAndUpdate({ uuid: doc.uuid }, { $set: patch }, { new: true }).lean();

    const keys = Object.keys(patch);
    await AuditRepo.log({
      action: 'user.update',
      entity: 'user',
      entityId: doc.uuid,
      before: { name: doc.name, role: doc.role, active: doc.active },
      after: { name: after.name, role: after.role, active: after.active },
      actor: req.user,
      meta: { keys },
    });
    res.json({ data: safe(after) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- OWNER RESET ----------------------------- */
/** Owner resets somebody else's PIN (forgot-PIN at the counter). */
usersRouter.post('/:id/reset-pin', owner, async (req, res, next) => {
  try {
    const body = z.object({ pin: z.string().regex(PIN_RE, 'PIN must be 4–6 digits') }).parse(req.body);
    const doc = await User.findOne({ uuid: req.params.id }).lean();
    if (!doc) throw notFound('User not found');

    await User.updateOne(
      { uuid: doc.uuid },
      { $set: { pinHash: await hashPin(body.pin), mustChangePin: true } }
    );

    await AuditRepo.log({
      action: 'user.reset_pin',
      entity: 'user',
      entityId: doc.uuid,
      after: { phone: doc.phone, name: doc.name },
      actor: req.user,
      meta: { note: 'PIN reset by owner; user must change it at next login' },
    });
    res.json({ ok: true, mustChangePin: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- SELF CHANGE ----------------------------- */
/** Any logged-in user changes their own PIN (old PIN required). */
usersRouter.post('/change-pin', async (req, res, next) => {
  try {
    const body = z
      .object({
        oldPin: z.string().min(4).max(6),
        newPin: z.string().regex(PIN_RE, 'New PIN must be 4–6 digits'),
      })
      .parse(req.body);

    if (body.oldPin === body.newPin) throw validation('New PIN must differ from the old one');

    const me = await User.findOne({ uuid: req.user.userId }).lean();
    if (!me) throw notFound('User not found');
    const ok = await verifyPin(body.oldPin, me.pinHash);
    if (!ok) throw unauthorized('Current PIN is incorrect', { field: 'oldPin' });

    await User.updateOne(
      { uuid: me.uuid },
      { $set: { pinHash: await hashPin(body.newPin), mustChangePin: false } }
    );

    await AuditRepo.log({
      action: 'user.change_pin',
      entity: 'user',
      entityId: me.uuid,
      after: { phone: me.phone },
      actor: req.user,
      meta: { note: 'self-service PIN change' },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
