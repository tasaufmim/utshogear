import { randomUUID } from 'node:crypto';

/** App-generated UUID PK — required so records created on two machines can merge. */
export const uuid = () => randomUUID();

export const isUuid = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
