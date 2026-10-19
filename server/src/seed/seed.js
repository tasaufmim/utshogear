/**
 * Seed: first-run data (settings + owner + cashier).
 * Later phases append categories/products/demo sales here — run repeatedly,
 * it is idempotent.
 *
 *   npm run seed
 */
import { connectMongo } from '../config/db.js';
import { User, getSettings } from '../models/Settings.js';
import { hashPin } from '../services/authService.js';
import { uuid } from '../lib/ids.js';
import { AuditRepo } from '../repos/AuditRepo.js';

const OWNER_PHONE = process.env.SEED_OWNER_PHONE || '01700000000';
const OWNER_PIN = process.env.SEED_OWNER_PIN || '1234';
const CASHIER_PHONE = process.env.SEED_CASHIER_PHONE || '01800000000';
const CASHIER_PIN = process.env.SEED_CASHIER_PIN || '1111';

async function upsertUser({ name, phone, pin, role, mustChangePin }) {
  const existing = await User.findOne({ phone });
  if (existing) {
    console.log(`  · user exists: ${role} ${phone}`);
    return existing;
  }
  const [user] = await User.create([
    {
      uuid: uuid(),
      name,
      phone,
      role,
      pinHash: await hashPin(pin),
      mustChangePin: !!mustChangePin,
      active: true,
    },
  ]);
  console.log(`  + created ${role}: ${name} (${phone}) · PIN ${pin}`);
  return user;
}

async function main() {
  await connectMongo({ retries: 4, delayMs: 800 });
  console.log('[seed] starting');

  // 1. settings singleton
  const settings = await getSettings();
  console.log(`  · settings: ${settings.shopName} · prefix ${settings.receiptPrefix}`);

  // 2. users
  const owner = await upsertUser({
    name: 'Owner',
    phone: OWNER_PHONE,
    pin: OWNER_PIN,
    role: 'owner',
    mustChangePin: process.env.SEED_FORCE_PIN_CHANGE === '1',
  });
  const cashier = await upsertUser({
    name: 'Cashier',
    phone: CASHIER_PHONE,
    pin: CASHIER_PIN,
    role: 'cashier',
    mustChangePin: false,
  });

  // 3. audit genesis (also proves the restricted role works end-to-end)
  const { count } = await AuditRepo.verify();
  if (count === 0) {
    await AuditRepo.log({
      action: 'system.seeded',
      entity: 'system',
      entityId: 'seed',
      after: { owner: owner.phone, cashier: cashier.phone },
      actor: { userId: null, name: 'seed-script', role: 'system' },
    });
    console.log('  + audit genesis written');
  } else {
    console.log(`  · audit log already has ${count} entries (chain verified)`);
  }

  const verify = await AuditRepo.verify();
  console.log(verify.intact ? `  ✅ audit chain intact (${verify.count} entries)` : `  ❌ BROKEN at #${verify.brokenAt}`);

  // Phase 2 catalog (categories, brands, bike models, demo products)
  const { seedCatalog } = await import('./seedCatalog.js');
  await seedCatalog(console.log);

  // Phase 7 default expense categories (idempotent)
  const { ExpenseCategory } = await import('../models/Finance.js');
  const DEFAULT_EXPENSE_CATS = ['Rent', 'Salary', 'Utilities', 'Transport', 'Tea & Food', 'Maintenance', 'Marketing', 'Misc'];
  for (const name of DEFAULT_EXPENSE_CATS) {
    const exists = await ExpenseCategory.findOne({ name });
    if (!exists) {
      await ExpenseCategory.create({ name, createdAt: new Date().toISOString() });
      console.log(`  + expense category: ${name}`);
    }
  }

  console.log('[seed] DONE');
  console.log(`[seed] owner   ${OWNER_PHONE} / ${OWNER_PIN}`);
  console.log(`[seed] cashier ${CASHIER_PHONE} / ${CASHIER_PIN}`);
  process.exit(verify.intact ? 0 : 1);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
