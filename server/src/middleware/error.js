import { ZodError } from 'zod';
import { AppError, isDuplicateKey, duplicateField } from '../lib/errors.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: 'Validation failed',
      code: 'VALIDATION',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (isDuplicateKey(err)) {
    const field = duplicateField(err);
    return res.status(409).json({
      error: `A record with this ${field} already exists`,
      code: 'DUPLICATE',
      details: { field },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Mongo validation errors
  if (err?.name === 'ValidationError') {
    const details = Object.values(err.errors || {}).map((e) => ({
      path: e.path,
      message: e.message,
    }));
    return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION', details });
  }

  if (err?.name === 'CastError') {
    return res.status(422).json({ error: `Invalid value for ${err.path}`, code: 'VALIDATION' });
  }

  if (err?.name === 'MongoServerError' && err.code === 251) {
    return res.status(500).json({
      error: 'Transaction aborted (is the replica set running?)',
      code: 'TXN_FAILED',
    });
  }

  req.log?.error({ err }, 'unhandled error');
  console.error('[error]', err);

  return res.status(500).json({
    error: env.isProd ? 'Internal server error' : err.message,
    code: 'INTERNAL',
    ...(env.isProd ? {} : { stack: err.stack?.split('\n').slice(0, 4) }),
  });
}
