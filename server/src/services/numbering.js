/**
 * Gapless document numbering, allocated INSIDE the business transaction so
 * a rolled-back checkout never burns a number... except where the number is
 * written before the commit — in which case the gap is still recorded in the
 * audit log by construction (allocation + sale share one commit).
 *
 *   sales : UGR-2026-000123
 *   return: URR-2026-000045      (prefix configurable, e.g. UGRR)
 *
 * Counters live in `counters` (the app role has find+update there).
 */
import { coll } from '../config/db.js';

/**
 * @param {object} o
 * @param {'receipt'|'return'} o.kind
 * @param {string} o.prefix   e.g. 'UGR'
 * @param {ClientSession} [o.session]
 * @returns {Promise<string>} e.g. 'UGR-2026-000123'
 */
export async function allocateNumber({ kind, prefix, session }) {
  const year = new Date().getUTCFullYear();
  const counters = coll('counters');

  let doc = await counters.findOneAndUpdate(
    { _id: kind },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', session, upsert: false }
  );

  // First use this year (or first ever): start a fresh sequence.
  if (!doc || doc.year !== year) {
    doc = await counters.findOneAndUpdate(
      { _id: kind },
      { $set: { year, seq: 1 } },
      { returnDocument: 'after', session, upsert: true }
    );
  }

  const seq = doc?.seq ?? 1;
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

/** Preview the next numbers without consuming them (owner-facing UI). */
export async function peekNumbers(prefixes = { receipt: 'UGR', return: 'UGRR' }) {
  const year = new Date().getUTCFullYear();
  const counters = coll('counters');
  const out = {};
  for (const [kind, prefix] of Object.entries(prefixes)) {
    const doc = await counters.findOne({ _id: kind });
    const seq = doc && doc.year === year ? doc.seq : 0;
    out[kind] = `${prefix}-${year}-${String(seq + 1).padStart(6, '0')}`;
  }
  return out;
}

/** Parse 'UGR-2026-000123' -> { prefix, year, seq } (null if malformed). */
export function parseNumber(no) {
  const m = /^([A-Z]+)-(\d{4})-(\d{6})$/.exec(String(no || ''));
  if (!m) return null;
  return { prefix: m[1], year: Number(m[2]), seq: Number(m[3]) };
}
