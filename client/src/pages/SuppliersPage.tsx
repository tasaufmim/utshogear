import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';

type Supplier = any;

export function SuppliersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('manageProducts');

  const [items, setItems] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'recent' | 'due' | 'name'>('recent');
  const [form, setForm] = useState<{ open: boolean; value: Supplier | null }>({ open: false, value: null });
  const [detail, setDetail] = useState<Supplier | null>(null);

  const load = () => {
    setLoading(true);
    api<{ data: Supplier[] }>('/suppliers', { query: { q, sort, limit: 100 } })
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q, sort]);

  const totals = useMemo(
    () => ({
      count: items.length,
      owed: items.reduce((s, x) => s + (x.dueBalance || 0), 0),
      creditors: items.filter((x) => (x.dueBalance || 0) > 0).length,
    }),
    [items]
  );

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Suppliers</div>
          <div className="k-value">{totals.count}</div>
        </div>
        <div className="card">
          <div className="k-label">We owe (payable)</div>
          <div className="k-value" style={{ color: totals.owed > 0 ? 'var(--red)' : undefined }}>
            {fmtTaka(totals.owed)}
          </div>
          <div className="k-delta">{totals.creditors} with outstanding balance</div>
        </div>
      </div>

      <div className="card mt">
        <div className="card-title">
          <div className="row wrap">
            <input
              className="input"
              style={{ width: 260 }}
              placeholder="Search supplier name / phone…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="input" style={{ width: 150 }} value={sort} onChange={(e) => setSort(e.target.value as any)}>
              <option value="recent">Recent</option>
              <option value="due">Most owed</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          <button className="btn primary" onClick={() => setForm({ open: true, value: null })}>
            + New supplier
          </button>
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon="🏭" title="No suppliers yet" hint="Add suppliers to track credit purchases (due)" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Phone</th>
                  <th>Last purchase</th>
                  <th className="num">Purchases</th>
                  <th className="num">Total bought</th>
                  <th className="num">We owe</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.uuid}>
                    <td style={{ fontWeight: 650 }}>{s.name}</td>
                    <td className="mono dim">{s.phone || '—'}</td>
                    <td className="dim nowrap">{s.lastPurchaseAt ? fmtDateTime(s.lastPurchaseAt) : 'never'}</td>
                    <td className="num">{s.purchaseCount || 0}</td>
                    <td className="num dim">{fmtTaka(s.totalPurchased || 0)}</td>
                    <td className="num">
                      {s.dueBalance > 0 ? <span className="badge bad">{fmtTaka(s.dueBalance)}</span> : <span className="badge ok">settled</span>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => setDetail(s)}>
                        Open
                      </button>{' '}
                      <button className="btn sm" onClick={() => setForm({ open: true, value: s })}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {form.open && (
        <SupplierForm
          value={form.value}
          onClose={() => setForm({ open: false, value: null })}
          onSaved={() => {
            setForm({ open: false, value: null });
            load();
          }}
        />
      )}

      {detail && <SupplierDetail uuid={detail.uuid} onClose={() => setDetail(null)} onChanged={load} />}
    </>
  );
}

/* ------------------------------- create/edit ------------------------------ */
function SupplierForm({ value, onClose, onSaved }: { value: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isEdit = !!value;
  const [f, setF] = useState({
    name: value?.name ?? '',
    phone: value?.phone ?? '',
    address: value?.address ?? '',
    note: value?.note ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f.name.trim()) return toast('Name is required', 'err');
    setBusy(true);
    try {
      if (isEdit) await api(`/suppliers/${value.uuid}`, { method: 'PATCH', body: f });
      else await api('/suppliers', { method: 'POST', body: f });
      toast(isEdit ? 'Supplier updated' : 'Supplier created', 'ok');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit — ${value.name}` : 'New supplier'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="field">
          <label>Name *</label>
          <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Phone</label>
          <input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Address</label>
          <input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Note</label>
          <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------- detail --------------------------------- */
function SupplierDetail({ uuid, onClose, onChanged }: { uuid: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api<any>(`/suppliers/${uuid}`)
      .then((r) => setData(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [uuid]);

  const pay = async () => {
    const cents = toCents(amount);
    if (cents <= 0) return toast('Enter an amount', 'err');
    setBusy(true);
    try {
      await api(`/suppliers/${uuid}/payments`, { method: 'POST', body: { amountCents: cents, method } });
      toast('Payment recorded', 'ok');
      setAmount('');
      load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !data)
    return (
      <Modal title="Supplier" onClose={onClose}>
        <div className="center" style={{ padding: 30 }}>
          <Spinner />
        </div>
      </Modal>
    );

  const s = data;

  return (
    <Modal title={s.name} onClose={onClose} wide>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        {s.phone && <Badge kind="info">☎ {s.phone}</Badge>}
        {s.address && <Badge>📍 {s.address}</Badge>}
        <Badge kind={s.dueBalance > 0 ? 'bad' : 'ok'}>
          {s.dueBalance > 0 ? `We owe ${fmtTaka(s.dueBalance)}` : 'No balance'}
        </Badge>
      </div>

      {s.dueBalance > 0 && (
        <div className="card" style={{ background: 'var(--red-50)', boxShadow: 'none', marginBottom: 12 }}>
          <div className="card-title">
            <h3>Pay supplier</h3>
            <span className="badge bad">due {fmtTaka(s.dueBalance)}</span>
          </div>
          <div className="row wrap">
            <input
              className="input"
              style={{ width: 170 }}
              inputMode="decimal"
              placeholder={`amount (max ${(s.dueBalance / 100).toFixed(2)})`}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            />
            <select className="input" style={{ width: 130 }} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bkash">bKash</option>
              <option value="nagad">Nagad</option>
              <option value="card">Card</option>
            </select>
            <button className="btn primary" onClick={pay} disabled={busy}>
              {busy ? <Spinner /> : 'Record payment'}
            </button>
          </div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Recent purchases</h3>
          <div className="tbl-wrap" style={{ maxHeight: 300 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Date</th>
                  <th className="num">Total</th>
                  <th className="num">Due</th>
                </tr>
              </thead>
              <tbody>
                {s.purchases.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim center">
                      No purchases yet
                    </td>
                  </tr>
                )}
                {s.purchases.map((p: any) => (
                  <tr key={p.uuid}>
                    <td className="mono">{p.ref}</td>
                    <td className="dim nowrap">{fmtDateTime(p.createdAt)}</td>
                    <td className="num">{fmtTaka(p.grandTotalCents)}</td>
                    <td className="num">{p.dueCents > 0 ? fmtTaka(p.dueCents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 style={{ marginBottom: 6 }}>Payments made</h3>
          <div className="tbl-wrap" style={{ maxHeight: 300 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {s.payments.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim center">
                      No payments yet
                    </td>
                  </tr>
                )}
                {s.payments.map((p: any) => (
                  <tr key={p.uuid}>
                    <td className="dim nowrap">{fmtDateTime(p.createdAt)}</td>
                    <td>
                      <Badge kind="info">{p.method}</Badge>
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtTaka(p.amountCents)}
                    </td>
                    <td className="dim">{p.userName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Modal>
  );
}
