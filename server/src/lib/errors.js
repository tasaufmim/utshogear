/** Application error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Not allowed', code = 'FORBIDDEN') => new AppError(403, code, msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg, details) => new AppError(409, 'CONFLICT', msg, details);
export const validation = (msg, details) => new AppError(422, 'VALIDATION', msg, details);

/** Recognise Mongo duplicate-key errors and turn them into 409s with the field name. */
export function isDuplicateKey(err) {
  return err && err.code === 11000;
}

export function duplicateField(err) {
  if (!isDuplicateKey(err)) return null;
  return Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
}
