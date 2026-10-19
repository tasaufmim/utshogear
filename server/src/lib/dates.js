/**
 * Date helpers.
 *
 * Rule: the server stores timestamps as ISO-8601 UTC strings (app-generated).
 * Business "day" boundaries are computed in the shop timezone (Asia/Dhaka, UTC+6),
 * because a sale at 00:30 Dhaka belongs to yesterday in UTC.
 *
 * No database-side date functions are used anywhere (portability rule).
 */

export const TZ_OFFSET_MINUTES = 6 * 60; // Asia/Dhaka is fixed UTC+6 (no DST)

const pad = (n) => String(n).padStart(2, '0');

/** Current instant, ISO-8601 UTC. */
export const nowIso = () => new Date().toISOString();

/** 'YYYY-MM-DD' in business timezone, for a given instant (default now). */
export function businessDate(at = new Date()) {
  const shifted = new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** UTC ISO instant for local midnight of a 'YYYY-MM-DD' business day (start). */
export function businessDayStartUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MINUTES * 60_000).toISOString();
}

/** Exclusive end (local midnight of the following day), as UTC ISO. */
export function businessDayEndUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - TZ_OFFSET_MINUTES * 60_000).toISOString();
}

/** Inclusive [from,to] business-day range -> { $gte, $lt } UTC ISO bounds for `field`. */
export function dayRange(fromDateStr, toDateStr) {
  return { $gte: businessDayStartUtc(fromDateStr), $lt: businessDayEndUtc(toDateStr) };
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Week start (Saturday by default, configurable) for a business date. */
export function weekStart(dateStr, weekStartsOn = 6) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow - weekStartsOn + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() - diff);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Calendar month range for a date: ['YYYY-MM-01', 'YYYY-MM-NN']. */
export function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [first, `${y}-${pad(m)}-${pad(lastDay)}`];
}

/** 'HH:MM' in business timezone. */
export function businessTime(at = new Date()) {
  const shifted = new Date(at.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}
