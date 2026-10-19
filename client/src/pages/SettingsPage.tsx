import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast, Spinner, Modal } from '../ui';
import { useAuth } from '../auth';

type Settings = any;

const TABS = ['Shop', 'Pricing', 'Printing', 'Receipt', 'SMS', 'Sync', 'Users'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('Shop');
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPinForm, setShowPinForm] = useState(false);

  const load = () =>
    api<{ data: Settings }>('/settings')
      .then((r) => setS(r.data))
      .catch((e) => toast(e.message, 'err'));

  useEffect(() => {
    load();
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const r = await api<{ data: Settings }>('/settings', { method: 'PATCH', body });
      setS(r.data);
      toast('Settings saved', 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  if (!s)
    return (
      <div className="card center" style={{ padding: 40 }}>
        <Spinner />
      </div>
    );

  const set = (key: string, value: unknown) => setS({ ...s, [key]: value });
  const setPrint = (group: 'labelPrinter' | 'receiptPrinter', key: string, value: unknown) =>
    setS({ ...s, [group]: { ...s[group], [key]: value } });

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Shop' && (
        <div className="card">
          <div className="card-title">
            <h2>Shop details</h2>
            <button className="btn primary" disabled={saving} onClick={() => patch({ shopName: s.shopName, address: s.address, phone: s.phone, footerNote: s.footerNote })}>
              {saving ? <Spinner /> : 'Save'}
            </button>
          </div>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Shop name">
              <input className="input" value={s.shopName} onChange={(e) => set('shopName', e.target.value)} />
            </Field>
            <Field label="Phone">
              <input className="input" value={s.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Address" wide>
              <input className="input" value={s.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label="Receipt footer note" wide>
              <input className="input" value={s.footerNote} onChange={(e) => set('footerNote', e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      {tab === 'Pricing' && (
        <div className="card">
          <div className="card-title">
            <h2>Pricing defaults</h2>
            <button className="btn primary" disabled={saving} onClick={() => patch({ defaultMarginPct: Number(s.defaultMarginPct), lowStockDefault: Number(s.lowStockDefault), returnWindowDays: Number(s.returnWindowDays), suggestCoverDays: Number(s.suggestCoverDays) })}>
              {saving ? <Spinner /> : 'Save'}
            </button>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="Default margin %" hint="Margin price = purchase price × (1 + this)">
              <input className="input" type="number" value={s.defaultMarginPct} onChange={(e) => set('defaultMarginPct', e.target.value)} />
            </Field>
            <Field label="Default low-stock level" hint="Used when a product has no own reorder level">
              <input className="input" type="number" value={s.lowStockDefault} onChange={(e) => set('lowStockDefault', e.target.value)} />
            </Field>
            <Field label="Return window (days)" hint="Beyond this needs owner PIN">
              <input className="input" type="number" value={s.returnWindowDays} onChange={(e) => set('returnWindowDays', e.target.value)} />
            </Field>
            <Field label="Suggested cover (days)" hint="Purchase suggestion targets this many days of stock">
              <input className="input" type="number" value={s.suggestCoverDays} onChange={(e) => set('suggestCoverDays', e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      {tab === 'Printing' && (
        <div className="card">
          <div className="card-title">
            <h2>Printer profiles</h2>
            <button className="btn primary" disabled={saving} onClick={() => patch({ labelPrinter: s.labelPrinter, receiptPrinter: s.receiptPrinter })}>
              {saving ? <Spinner /> : 'Save'}
            </button>
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>
            The browser's print dialog talks to the actual hardware — these profiles store paper
            size, template and margin offsets so every job lays out the same way. Full calibration
            & test-print screen arrives in Phase 3.
          </p>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="card" style={{ boxShadow: 'none' }}>
              <h3>Label printer</h3>
              <div className="grid mt">
                <Field label="Name">
                  <input className="input" value={s.labelPrinter.name} onChange={(e) => setPrint('labelPrinter', 'name', e.target.value)} />
                </Field>
                <Field label="Paper width">
                  <select className="input" value={s.labelPrinter.paperWidth} onChange={(e) => setPrint('labelPrinter', 'paperWidth', e.target.value)}>
                    <option value="38mm">38mm (38×25 thermal)</option>
                    <option value="50mm">50mm (50×30 thermal)</option>
                    <option value="A4">A4 sheet</option>
                  </select>
                </Field>
                <Field label="Template">
                  <select className="input" value={s.labelPrinter.template} onChange={(e) => setPrint('labelPrinter', 'template', e.target.value)}>
                    <option value="38x25">38 × 25 mm</option>
                    <option value="50x30">50 × 30 mm</option>
                    <option value="a4-3x8">A4 · 3 × 8</option>
                    <option value="a4-3x7">A4 · 3 × 7</option>
                    <option value="a4-5x3">A4 · 5 × 3</option>
                  </select>
                </Field>
                <Field label="Show MRP on label">
                  <select className="input" value={String(s.labelPrinter.showMrp)} onChange={(e) => setPrint('labelPrinter', 'showMrp', e.target.value === 'true')}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </Field>
              </div>
            </div>

            <div className="card" style={{ boxShadow: 'none' }}>
              <h3>Receipt printer</h3>
              <div className="grid mt">
                <Field label="Name">
                  <input className="input" value={s.receiptPrinter.name} onChange={(e) => setPrint('receiptPrinter', 'name', e.target.value)} />
                </Field>
                <Field label="Paper width">
                  <select className="input" value={s.receiptPrinter.paperWidth} onChange={(e) => setPrint('receiptPrinter', 'paperWidth', e.target.value)}>
                    <option value="80mm">80mm</option>
                    <option value="58mm">58mm</option>
                  </select>
                </Field>
                <Field label="Auto-print after checkout">
                  <select className="input" value={String(s.receiptPrinter.autoPrint)} onChange={(e) => setPrint('receiptPrinter', 'autoPrint', e.target.value === 'true')}>
                    <option value="true">Yes</option>
                    <option value="false">No (Ctrl+P instead)</option>
                  </select>
                </Field>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'Receipt' && (
        <div className="card">
          <div className="card-title">
            <h2>Receipt numbering & branding</h2>
            <button className="btn primary" disabled={saving} onClick={() => patch({ receiptPrefix: s.receiptPrefix, returnPrefix: s.returnPrefix, footerNote: s.footerNote })}>
              {saving ? <Spinner /> : 'Save'}
            </button>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Field label="Sales receipt prefix">
              <input className="input" value={s.receiptPrefix} onChange={(e) => set('receiptPrefix', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Return receipt prefix">
              <input className="input" value={s.returnPrefix} onChange={(e) => set('returnPrefix', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Next sales number (system)">
              <input className="input" readOnly value={`${s.receiptYear}-${String(s.receiptSeq + 1).padStart(6, '0')}`} />
            </Field>
          </div>
          <p className="hint mt">
            Counters are generated by the server and cannot be edited here — any change to the
            sequence is written to the immutable audit log.
          </p>
        </div>
      )}

      {tab === 'SMS' && (
        <div className="card">
          <div className="card-title">
            <h2>SMS gateway</h2>
            <span className="badge warn">hook only — no provider key yet</span>
          </div>
          <p className="hint" style={{ marginBottom: 14 }}>
            The notification queue (low-stock digest, due reminders, daily owner summary) already
            works offline and stores messages here. Add a provider key later and the same queue
            starts delivering — no code changes.
          </p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="Provider">
              <select className="input" value={s.smsConfig?.provider ?? 'null'} onChange={(e) => set('smsConfig', { ...s.smsConfig, provider: e.target.value })}>
                <option value="null">None (queue only)</option>
                <option value="bulksmsbd">bulksmsbd.net</option>
              </select>
            </Field>
            <Field label="API key">
              <input className="input" type="password" placeholder="••••••••" value={s.smsConfig?.apiKey ?? ''} onChange={(e) => set('smsConfig', { ...s.smsConfig, apiKey: e.target.value })} />
            </Field>
            <Field label="Sender ID">
              <input className="input" value={s.smsConfig?.senderId ?? ''} onChange={(e) => set('smsConfig', { ...s.smsConfig, senderId: e.target.value })} />
            </Field>
            <Field label="Enabled">
              <select className="input" value={String(!!s.smsConfig?.enabled)} onChange={(e) => set('smsConfig', { ...s.smsConfig, enabled: e.target.value === 'true' })}>
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </Field>
          </div>
          <button className="btn primary mt" disabled={saving} onClick={() => patch({ smsConfig: s.smsConfig })}>
            {saving ? <Spinner /> : 'Save SMS config'}
          </button>
        </div>
      )}

      {tab === 'Sync' && <SyncTab />}

      {tab === 'Users' && (
        <div className="card">
          <div className="card-title">
            <h2>Account</h2>
            <button className="btn" onClick={() => setShowPinForm(true)}>
              Change my PIN
            </button>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{user?.name}</td>
                  <td className="mono">{user?.phone}</td>
                  <td>
                    <span className="badge info">{user?.role}</span>
                  </td>
                  <td>
                    <span className="badge ok">active</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint mt">
            Full user management — create cashiers, roles, PIN resets, deactivation — lives in{' '}
            <a href="/users">System → Users &amp; PINs</a>. PINs are stored only as bcrypt hashes;
            every change is recorded in the audit log.
          </p>
        </div>
      )}

      {showPinForm && <ChangePinModal onClose={() => setShowPinForm(false)} />}
    </>
  );
}

/** One-way push of the local database to Atlas (owner's remote read-only copy). */
function SyncTab() {
  const toast = useToast();
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ data: any }>('/sync/status')
      .then((r) => setStatus(r.data))
      .catch((e) => toast(e.message, 'err'));

  useEffect(() => {
    load();
  }, []);

  const push = async () => {
    setBusy(true);
    try {
      const r = await api<{ data: any }>('/sync/push', { method: 'POST' });
      const d = r.data;
      if (d.skipped) toast(d.reason, 'err');
      else if (d.ok) toast(`Pushed ${Object.keys(d.collections).length} collections in ${d.durationMs}ms`, 'ok');
      else toast(`Push finished with errors: ${d.errors?.join('; ')}`, 'err');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!status)
    return (
      <div className="card center" style={{ padding: 40 }}>
        <Spinner />
      </div>
    );

  return (
    <div className="card">
      <div className="card-title">
        <h2>Atlas push sync</h2>
        <button className="btn primary" disabled={busy || !status.configured} onClick={push}>
          {busy ? <Spinner /> : '⬆ Push now'}
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <div>
          <div className="dim">Mode</div>
          <b>{status.configured ? 'pushing to Atlas' : status.enabled ? 'enabled but not configured' : 'off — local only'}</b>
        </div>
        <div>
          <div className="dim">Target</div>
          <b className="mono" style={{ fontSize: 13 }}>
            {status.atlasTarget || '—'}
          </b>
        </div>
        <div>
          <div className="dim">Last push</div>
          <b>{status.lastPushAt ? new Date(status.lastPushAt).toLocaleString() : 'never'}</b>
        </div>
        <div>
          <div className="dim">Pushes</div>
          <b>
            {status.pushCount} · every {status.intervalMin} min
          </b>
        </div>
        <div>
          <div className="dim">Audit cursor (seq)</div>
          <b>#{status.auditCursor}</b>
        </div>
      </div>

      {status.lastError && (
        <p className="hint err-text" style={{ marginTop: 10 }}>
          Last error: {status.lastError}
        </p>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        Local Mongo is the source of truth. This pushes a full mirror to Atlas so the owner's
        <b> READONLY</b> instance (same app, <code>READONLY=1</code>, <code>ATLAS_URL</code> pointed at
        Atlas) can serve reports from anywhere. Configure <code>SYNC_ENABLED=1</code> +{' '}
        <code>ATLAS_URL</code> in <code>.env</code>; the push also runs automatically on the interval.
        The shop keeps working offline if Atlas is unreachable — sync just retries later.
      </p>
    </div>
  );
}

function ChangePinModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [oldPin, setOld] = useState('');
  const [newPin, setNew] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!/^\d{4,6}$/.test(newPin)) return toast('New PIN must be 4–6 digits', 'err');
    setBusy(true);
    try {
      await api('/users/change-pin', {
        method: 'POST',
        // identity comes from the bearer token — works after any reload
        body: { oldPin, newPin },
      });
      toast('PIN changed', 'ok');
      onClose();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change PIN"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : 'Update PIN'}
          </button>
        </>
      }
    >
      <div className="grid">
        <Field label="Current PIN">
          <input className="input" type="password" maxLength={6} value={oldPin} onChange={(e) => setOld(e.target.value)} />
        </Field>
        <Field label="New PIN (4–6 digits)">
          <input className="input" type="password" maxLength={6} value={newPin} onChange={(e) => setNew(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
