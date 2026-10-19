import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { getSettings, Settings } from '../models/Settings.js';
import { AuditRepo } from '../repos/AuditRepo.js';
import { env } from '../config/env.js';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

/** GET /api/settings — shop configuration (some keys are owner-only). */
settingsRouter.get('/', async (req, res, next) => {
  try {
    const doc = await getSettings();
    const { smsConfig, ...rest } = doc;
    if (req.user.role === 'owner') rest.smsConfig = smsConfig;
    res.json({ data: rest, readonly: env.readonly });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z
  .object({
    shopName: z.string().min(1).max(80).optional(),
    address: z.string().max(200).optional(),
    phone: z.string().max(30).optional(),
    logo: z.string().max(500).nullable().optional(),

    receiptPrefix: z.string().min(2).max(8).optional(),
    returnPrefix: z.string().min(2).max(8).optional(),

    defaultMarginPct: z.number().min(0).max(1000).optional(),
    lowStockDefault: z.number().int().min(0).max(9999).optional(),
    returnWindowDays: z.number().int().min(0).max(365).optional(),
    suggestCoverDays: z.number().int().min(1).max(120).optional(),
    footerNote: z.string().max(200).optional(),

    labelPrinter: z
      .object({
        name: z.string().max(60).optional(),
        paperWidth: z.string().max(10).optional(),
        template: z.string().max(20).optional(),
        marginTop: z.number().min(-5).max(20).optional(),
        marginLeft: z.number().min(-5).max(20).optional(),
        showMrp: z.boolean().optional(),
      })
      .optional(),
    receiptPrinter: z
      .object({
        name: z.string().max(60).optional(),
        paperWidth: z.string().max(10).optional(),
        autoPrint: z.boolean().optional(),
      })
      .optional(),

    smsConfig: z
      .object({
        provider: z.enum(['null', 'bulksmsbd']).optional(),
        apiKey: z.string().max(200).optional(),
        senderId: z.string().max(30).optional(),
        enabled: z.boolean().optional(),
      })
      .optional(),

    dailySummaryEnabled: z.boolean().optional(),
    lowStockDigestEnabled: z.boolean().optional(),
  })
  .strict();

/** PATCH /api/settings — owner only. Every change is audited (incl. receipt counters). */
settingsRouter.patch('/', requireOwner, async (req, res, next) => {
  try {
    const patch = patchSchema.parse(req.body);

    // Receipt counters are never client-settable (fraud surface) — read them for the audit only.
    delete patch.receiptYear;
    delete patch.receiptSeq;
    delete patch.returnSeq;
    delete patch.uuid;

    const before = await getSettings();
    const updated = await Settings.findOneAndUpdate(
      { uuid: 'settings-singleton' },
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
      { new: true }
    ).lean();

    await AuditRepo.log({
      action: 'settings.update',
      entity: 'settings',
      entityId: 'settings-singleton',
      before: pickChanged(before, patch),
      after: pickChanged(updated, patch),
      actor: req.user,
      meta: { keys: Object.keys(patch) },
    });

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

function pickChanged(doc, patch) {
  const out = {};
  for (const key of Object.keys(patch)) out[key] = doc?.[key];
  return out;
}
