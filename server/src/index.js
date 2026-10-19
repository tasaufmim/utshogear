import { env } from './config/env.js';
import { connectMongo } from './config/db.js';
import { createApp } from './app.js';
import { startSyncLoop } from './services/syncService.js';

async function main() {
  console.log(`[boot] UGR ERP server · mode=${env.readonly ? 'READ-ONLY' : 'read-write'} · ${env.nodeEnv}`);

  await connectMongo();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[boot] listening on http://localhost:${env.port}/api`);
  });

  // One-way push to Atlas (owner's remote read-only copy). No-op unless configured.
  startSyncLoop();

  // Graceful shutdown: finish in-flight requests, then close the pool.
  const shutdown = (signal) => async () => {
    console.log(`\n[shutdown] ${signal} received`);
    server.close(async () => {
      const { default: mongoose } = await import('mongoose');
      await mongoose.connection.close();
      console.log('[shutdown] closed cleanly');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
