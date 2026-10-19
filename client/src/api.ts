/**
 * Tiny typed fetch wrapper (no axios).
 * - attaches bearer token
 * - maps {error, code} envelopes onto a typed ApiError
 * - never throws for expected API errors — callers read err.code
 */

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TOKEN_KEY = 'ugr.token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

type Opts = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
};

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const { method = 'GET', body, query, headers: extraHeaders } = opts;

  let url = path.startsWith('/api') ? path : `/api${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server');
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    /* 204 / non-json */
  }

  if (!res.ok) {
    const err = new ApiError(
      res.status,
      payload?.code || `HTTP_${res.status}`,
      payload?.error || `Request failed (${res.status})`,
      payload?.details
    );
    if (res.status === 401 && path !== '/auth/login') {
      setToken(null);
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw err;
  }
  return payload as T;
}

export const fmtTaka = (cents: number, withSymbol = true) => {
  const n = (Number(cents) || 0) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? '৳' + s : s;
};

export const toCents = (v: string | number): number => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
