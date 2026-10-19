import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as auth from '../services/authService.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { env } from '../config/env.js';

export const authRouter = Router();

const loginSchema = z.object({
  phone: z.string().min(6).max(20),
  pin: z.string().min(4).max(6),
});

const changeSchema = z.object({
  phone: z.string().min(6).max(20),
  oldPin: z.string().min(4).max(6),
  newPin: z.string().min(4).max(6),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const result = await auth.login(body, { readonly: env.readonly });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const unlockSchema = z.object({
  pin: z.string().min(4).max(6),
});

authRouter.post('/unlock', requireAuth, async (req, res, next) => {
  try {
    const body = unlockSchema.parse(req.body);
    res.json(await auth.unlock({ pin: body.pin, userId: req.user.userId }));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-pin', requireAuth, async (req, res, next) => {
  try {
    const body = changeSchema.parse(req.body);
    res.json(
      await auth.changePin(body, {
        userId: req.user.userId,
        name: req.user.name,
        role: req.user.role,
      })
    );
  } catch (err) {
    next(err);
  }
});

/** Who am I — used by the client to restore a session on reload. */
authRouter.get('/session', requireAuth, (req, res) => {
  res.json({
    user: {
      uuid: req.user.userId,
      name: req.user.name,
      phone: req.user.phone ?? null,
      role: req.user.role,
      mustChangePin: req.user.mustChangePin,
    },
    idleLockMinutes: env.auth.idleLockMinutes,
    readonly: env.readonly,
  });
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await AuditRepo.log({
      action: 'auth.logout',
      entity: 'user',
      entityId: req.user.userId,
      actor: req.user,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** List users (owner only) — for the user-management screen. */
authRouter.get('/users', requireAuth, requireRole('owner'), async (_req, res, next) => {
  try {
    const { User } = await import('../models/Settings.js');
    const users = await User.find({ deletedAt: null })
      .select('-pinHash -failedLogins -lockUntil')
      .sort({ createdAt: 1 })
      .lean();
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});
