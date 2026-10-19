import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { readonlyGuard } from './middleware/readonly.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { auditRouter } from './routes/audit.js';
import { categoriesRouter, brandsRouter, bikeModelsRouter } from './routes/catalog.js';
import { productsRouter } from './routes/products.js';
import { salesRouter, parksRouter } from './routes/sales.js';
import { customersRouter } from './routes/customers.js';
import { inventoryRouter } from './routes/inventory.js';
import { suppliersRouter, purchasesRouter } from './routes/supply.js';
import { expensesRouter } from './routes/expenses.js';
import { reportsRouter } from './routes/reports.js';
import { returnsRouter } from './routes/returns.js';
import { usersRouter } from './routes/users.js';
import { notificationsRouter } from './routes/notifications.js';
import { syncRouter } from './routes/sync.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.isProd ? true : [/localhost:\d+$/, /127\.0\.0\.1:\d+$/],
      credentials: true,
    })
  );
  app.use(
    pinoHttp({
      level: env.isProd ? 'info' : 'info',
      transport:
        !env.isProd && process.stdout.isTTY
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
          : undefined,
      // never write credentials to logs
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-owner-pin"]'],
        censor: '[redacted]',
      },
      quietReqLogger: true,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    })
  );
  app.use(express.json({ limit: '2mb' }));

  // 1. READONLY guard — before anything can mutate
  app.use(readonlyGuard);

  // 2. Routes
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/brands', brandsRouter);
  app.use('/api/bike-models', bikeModelsRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/parks', parksRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/purchases', purchasesRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/returns', returnsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/sync', syncRouter);

  // Uploaded product images (Phase 2)
  app.use(
    '/uploads',
    express.static(new URL('../uploads', import.meta.url).pathname, {
      maxAge: env.isProd ? '7d' : 0,
    })
  );

  // 3. Errors
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
