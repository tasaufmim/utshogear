# UGR — ERP / Inventory + POS

Offline-first business system for a **motorcycle accessories** shop:
POS, catalog with barcodes, inventory ledger, purchasing & suppliers,
customer debt, returns & exchanges, daily costing, and profit reports.
MERN (Vite React + Express + MongoDB), BDT ৳, receipts `UGR-2026-000123`,
returns `UGRR-2026-000001`, purchases `PUR-2026-000001`.

## Prerequisites

- Node.js ≥ 18 (developed on 26.x)
- MongoDB Community with `mongod` + `mongosh` on PATH (9.x via `brew install mongodb-community`)
- `mongodump` / `mongorestore` (mongodb-database-tools) for backups
- Git

## First-time setup

```bash
cp .env.example .env        # then set JWT_SECRET + MONGO_APP_PASS
npm install                 # installs server + client workspaces
npm run mongo:start         # launches mongod as single-node replica set rs0 (forked)
npm run mongo:rs-init       # initiates rs0, creates restricted roles/user, builds indexes
npm run mongo:verify-roles  # PROVES audit_log cannot be updated/deleted by the app
npm run seed                # settings + owner/cashier + catalog + expense categories
npm run dev                 # server :4000 + client :5173
```

Login: **owner** `01700000000` / PIN `1234` · **cashier** `01800000000` / PIN `1111`
(override via `SEED_*` env vars before seeding).

## What it does

| Area | Details |
|---|---|
| **POS** | Barcode scan or dynamic search (name/model/barcode), line + order discounts (%/৳), hold & recall carts, cash/bKash/Nagad/due, gapless receipt numbers, idempotent checkout, 80mm/58mm thermal receipts, reprint & void (restocks automatically) |
| **Cashier guards** | Selling below floor price, >10% order discount, voiding, and out-of-window returns all require the **owner PIN** — the cashier's screen never shows costs or profit |
| **Catalog** | Categories, brands, bike-model fitment, sizes as variants; four prices per item (purchase / avg cost / floor / margin / MRP) — cost fields owner-only; barcode generation + label printing (38×25, 50×30, A4 sheets) |
| **Inventory** | Append-only `stock_moves` ledger (SALE/PURCHASE/RETURN/ADJUST/EXCHANGE…), audited manual adjustments, one-click reconcile (cache rebuilt from ledger), live low-stock detection + reminder queue |
| **Purchasing** | Goods-received with freight allocated by line value → weighted-average cost update, supplier accounts payable, supplier payments |
| **Customers** | Walk-in or registered, due balance from ledger, payment receipts, per-customer analytics |
| **Returns & exchange** | Refund at the price actually paid, restock-or-damage flag, cash/original/debt-adjust refund, exchange = return + new sale in **one transaction**, `UGRR-` numbers, return window enforced with owner override |
| **Daily costing** | Expense categories + entries (rent, salary, transport…), owner-only, audited edits/deletes |
| **Reports** | Daily/weekly/monthly/6-month/yearly profit (sales − COGS − expenses), top sellers, expense breakdown, cash book (BDT business-date bucketed, Asia/Dhaka), CSV export |
| **Notifications** | Low-stock + debt reminders and a daily digest — fully offline in-app; optional SMS provider (BulkSMSBD) sends with an append-only `sms_log` journal |
| **Users** | Owner/cashier management, bcrypt PINs, forced first-login PIN change, owner PIN reset, self-service change — all audited |
| **Audit log** | Hash-chained, immutable (see below), CSV export, one-click chain verification |

## Run modes

| Mode | How | Behaviour |
|---|---|---|
| Local (shop) | `npm run dev` / `npm start` | Read-write; local Mongo is the source of truth and works offline |
| Owner remote view | second instance, `READONLY=1` | Every business write → 403; browse reports from anywhere |
| Backup | `npm run backup [-- --keep 14]` | `mongodump --gzip` into `backups/utsho-<ts>/` |
| Restore | `npm run restore -- latest --yes` | Drops + restores the DB from a snapshot (stop the API first) |

## Why a replica set (not optional)

| Capability | What it gives us |
|---|---|
| Multi-document transactions | sale + stock deduction + receipt counter + audit entry commit together or not at all |
| Change streams | clean one-way push sync to Atlas (optional, `SYNC_ENABLED`) |

## Immutable audit log — the three guarantees

1. `AuditRepo` exposes **only** `log() / find() / verify()` — no update, no delete, by construction.
2. The Mongo app role grants `find`+`insert` **only** on `audit_log` (`scripts/rs-init.mjs`).
   `npm run mongo:verify-roles` proves update/delete are rejected *by the database itself*.
3. Every entry stores `hash = sha256(prevHash + canonical(entry))`; `GET /api/audit/verify`
   (or `npm run audit:verify`) walks the chain and reports the first broken link.
   Every business transaction inserts its audit row **inside the same Mongo transaction**.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | concurrent server + client |
| `npm run mongo:start` | start local mongod with `--replSet rs0` |
| `npm run mongo:rs-init` | initiate rs0, roles, user, indexes (idempotent) |
| `npm run mongo:verify-roles` | verify audit immutability guarantees |
| `npm run seed` | idempotent first-run data |
| `npm run backup [-- --keep N]` | gzip backup into `backups/` (+ prune) |
| `npm run restore -- --list \| latest --yes` | disaster recovery |
| `npm run reconcile [-- --fix]` | `SUM(stock_moves)` vs cached `products.stock` |
| `npm run audit:verify` | hash-chain verification from the CLI |

## API surface (all under `/api`, JWT bearer)

`auth` · `settings` · `users` · `catalog` (categories/brands/bike-models) · `products`
(+ `products/search`, `:id/barcode.png`) · `sales` (+ `parks`, `today`, `:id/void`)
· `customers` (+ payments, due-ledger, analytics) · `inventory` (+ moves, adjust,
low-stock, scan, reconcile, summary) · `suppliers` (+ payments) · `purchases`
· `returns` · `expenses` (+ categories) · `reports` (summary, series, profit,
top-products, expenses-by-category, cashbook) · `notifications` (+ low-stock,
due-reminders, daily-digest, send) · `audit` (+ verify, export) · `health`.

Responses use a `{ data, meta? }` envelope; cashiers receive cost/profit-free
shapes enforced server-side (`stripFor`), never just hidden in the UI.

## Layout

```
server/   Express API (ESM, plain JS)  src/{config,lib,models,middleware,routes,services,repos,seed}
client/   Vite + React + TS            src/{pages,components}
scripts/  operational scripts (mongo-start, rs-init, verify-roles, backup, restore, reconcile, audit-verify)
backups/  timestamped mongodump archives (gitignored)
```

## Money rule

Amounts are stored as **integer cents** everywhere server-side; ৳ formatting happens only
at the UI edge. Never use floating point for money.

## Business dates

Ledger collections store app-generated ISO-8601 UTC strings; reports bucket by the
**Asia/Dhaka business date** (`YYYY-MM-DD` strings), so a sale at 2am belongs to
"today" in shop time, and every range query is a plain string comparison.
