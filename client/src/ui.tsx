import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/* ---------------- toasts ---------------- */
type Toast = { id: number; text: string; kind?: 'ok' | 'err' | undefined };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind?: Toast['kind']) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, kind }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3800);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------------- modal ---------------- */
export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="between" style={{ marginBottom: 14 }}>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
        {footer && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */
export const Spinner = () => <span className="spinner" aria-label="loading" />;

export function Empty({ icon = '📋', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 650, color: 'var(--text-2)' }}>{title}</div>
      {hint && <div className="dim" style={{ marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

export function Badge({
  kind = '',
  children,
}: {
  kind?: 'ok' | 'warn' | 'bad' | 'info' | '';
  children: React.ReactNode;
}) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

/** Period switcher used across dashboard + reports. */
export type PeriodPreset = 'daily' | 'weekly' | 'monthly' | '6m' | 'yearly' | 'custom';

export const PERIODS: { key: PeriodPreset; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: '6m', label: '6 Months' },
  { key: 'yearly', label: 'Yearly' },
];

export function PeriodSwitch({
  value,
  onChange,
  allowCustom,
}: {
  value: PeriodPreset;
  onChange: (p: PeriodPreset) => void;
  allowCustom?: boolean;
}) {
  const list = allowCustom ? [...PERIODS, { key: 'custom' as const, label: 'Custom' }] : PERIODS;
  return (
    <div className="pill-group">
      {list.map((p) => (
        <button
          key={p.key}
          className={value === p.key ? 'on' : ''}
          onClick={() => onChange(p.key)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Money display — ৳ with tabular numerals. */
export const Taka = ({ cents, muted }: { cents: number; muted?: boolean }) => (
  <span className={muted ? 'dim' : undefined}>৳{(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
);

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, reload: load };
}

export const fmtDate = (iso: string) => (iso ? iso.slice(0, 10) : '—');
export const fmtDateTime = (iso: string) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '—';
