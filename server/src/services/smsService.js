/**
 * SMS provider adapter — optional by design.
 *
 * The app is fully usable without it: reminders live in the notifications
 * collection and the owner UI. When SMS_PROVIDER=bulksmsbd is configured
 * (see .env.example), queued notifications can be pushed out; every attempt
 * is journaled to `sms_log` (append-only) for audit and cost tracking.
 *
 * Adding another Bangladeshi provider (e.g. BulkSMSBD, AlphaSMS, Robi
 * JomShoJom) is one more case in sendSms().
 */
import { coll } from '../config/db.js';
import { uuid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';

export function smsConfigured() {
  return Boolean(process.env.SMS_PROVIDER && process.env.SMS_USER && process.env.SMS_PASS);
}

/**
 * @param {{to: string, text: string, kind?: string}} msg
 * @returns {Promise<{ok: boolean, provider: string, detail?: string}>}
 */
export async function sendSms({ to, text, kind = 'info' }) {
  const provider = process.env.SMS_PROVIDER || 'none';

  if (!smsConfigured()) {
    await journal({ to, text, kind, provider: 'none', ok: false, detail: 'provider not configured' });
    return { ok: false, provider, detail: 'SMS provider not configured' };
  }

  if (provider === 'bulksmsbd') {
    // BulkSMSBD HTTP API — kept minimal on purpose; no SDK dependency.
    const url = new URL('http://bulksmsbd.net/api/smsapi');
    url.searchParams.set('api_key', process.env.SMS_API_KEY || '');
    url.searchParams.set('senderid', process.env.SMS_SENDERID || '8809612notify');
    url.searchParams.set('number', normalizeBdPhone(to));
    url.searchParams.set('message', text);

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      // API returns "ERROR_CODE:Description" or "request_id:...." on success
      const ok = res.ok && !body.startsWith('1') && !body.toLowerCase().startsWith('error');
      await journal({ to, text, kind, provider, ok, detail: body.slice(0, 200) });
      return { ok, provider, detail: body.slice(0, 200) };
    } catch (err) {
      await journal({ to, text, kind, provider, ok: false, detail: err.message });
      return { ok: false, provider, detail: err.message };
    }
  }

  await journal({ to, text, kind, provider, ok: false, detail: `unknown provider ${provider}` });
  return { ok: false, provider, detail: `unknown provider ${provider}` };
}

/** 01712345678 → 8801712345678 (BulkSMSBD expects international format). */
function normalizeBdPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `88${digits}`;
  return `880${digits}`;
}

async function journal({ to, text, kind, provider, ok, detail }) {
  try {
    await coll('sms_log').insertOne({
      uuid: uuid(),
      to,
      text,
      kind,
      provider,
      ok,
      detail: detail ?? '',
      createdAt: nowIso(),
    });
  } catch (err) {
    console.warn(`[sms] journal failed: ${err.message}`);
  }
}
