import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';

type Customer = any;

export function CustomersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('viewCost');

  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [hasDue, setHasDue] = useState(false);
  const [sort, setSort] = useState<'recent' | 'due' | 'name'>('recent');

  const [form, setForm] = useState<{ open: boolean; value: Customer | null }>({ open: false, value: null });
  const [detail, setDetail] = useState<Customer | null>(null);

  const load = () => {
    setLoading(true);
    api<{ data: Customer[] }>('/customers', {
      query: { q, hasDue: hasDue ? '1' : '', sort, limit: 100 },
    })
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q, hasDue, sort]);

  const totals = useMemo(
    () => ({
      count: items.length,
      due: items.reduce((s, c) => s + (c.dueBalance || 0), 0),
      debtors: items.filter((c) => (c.dueBalance || 0) > 0).length,
    }),
    [items]
  );

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Customers</div>
          <div className="k-value">{totals.count}</div>
        </div>
        <div className="card">
          <div className="k-label">Owed to the shop</div>
          <div className="k-value" style={{ color: totals.due > 0 ? 'var(--red)' : undefined }}>
            {fmtTaka(totals.due)}
          </div>
          <div className="k-delta">{totals.debtors} customer(s) in debt</div>
        </div>
        <div className="card">
          <div className="k-label">Debt collection</div>
          <div className="k-value" style={{ fontSize: 17 }}>
            {totals.due > 0 ? 'Follow up today' : 'all clear 🎉'}
          </div>
        </div>
      </div>

      <div className="card mt">
        <div className="card-title">
          <div className="row wrap">
            <input
              className="input"
              style={{ width: 260 }}
              placeholder="Search name, phone, bike…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="row gap-sm dim" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={hasDue} onChange={(e) => setHasDue(e.target.checked)} />
              In debt only
            </label>
            <select className="input" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as any)}>
              <option value="recent">Recent</option>
              <option value="due">Biggest due</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          <button className="btn primary" onClick={() => setForm({ open: true, value: null })}>
            + New customer
          </button>
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon="👤" title="No customers yet" hint="Create one at checkout or here — credit sales need a customer" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Bike / note</th>
                  <th>Last visit</th>
                  <th className="num">Visits</th>
                  {owner && <th className="num">Spent</th>}
                  <th className="num">Due</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.uuid}>
                    <td style={{ fontWeight: 650 }}>{c.name}</td>
                    <td className="mono dim">{c.phone || '—'}</td>
                    <td className="dim">{c.bikes || c.note || '—'}</td>
                    <td className="dim nowrap">{c.lastVisitAt ? fmtDateTime(c.lastVisitAt) : 'never'}</td>
                    <td className="num">{c.visitCount || 0}</td>
                    {owner && <td className="num dim">{fmtTaka(c.totalSpent || 0)}</td>}
                    <td className="num">
                      {(c.dueBalance || 0) > 0 ? (
                        <span className="badge bad">{fmtTaka(c.dueBalance)}</span>
                      ) : (
                        <span className="badge ok">settled</span>
                      )}
                    </td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => setDetail(c)}>
                        Open
                      </button>{' '}
                      <button className="btn sm" onClick={() => setForm({ open: true, value: c })}>
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
        <CustomerForm
          value={form.value}
          onClose={() => setForm({ open: false, value: null })}
          onSaved={() => {
            setForm({ open: false, value: null });
            load();
          }}
        />
      )}

      {detail && (
        <CustomerDetail
          uuid={detail.uuid}
          onClose={() => setDetail(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

/* ------------------------------ create / edit ----------------------------- */
function CustomerForm({ value, onClose, onSaved }: { value: Customer | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isEdit = !!value;
  const [f, setF] = useState({
    name: value?.name ?? '',
    phone: value?.phone ?? '',
    address: value?.address ?? '',
    bikes: value?.bikes ?? '',
    note: value?.note ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f.name.trim()) return toast('Name is required', 'err');
    setBusy(true);
    try {
      if (isEdit) await api(`/customers/${value.uuid}`, { method: 'PATCH', body: f });
      else await api('/customers', { method: 'POST', body: f });
      toast(isEdit ? 'Customer updated' : 'Customer created', 'ok');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit — ${value.name}` : 'New customer'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
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
        <div className="field">
          <label>Bike(s)</label>
          <input className="input" placeholder="Pulsar 150, red" value={f.bikes} onChange={(e) => setF({ ...f, bikes: e.target.value })} />
        </div>
        <div className="field">
          <label>Note</label>
          <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------- detail --------------------------------- */
function CustomerDetail({ uuid, onClose, onChanged }: { uuid: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('viewCost');

  const [tab, setTab] = useState<'ledger' | 'analytics'>('ledger');
  const [data, setData] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api<any>(`/customers/${uuid}/due-ledger`),
      api<any>(`/customers/${uuid}/analytics`).catch(() => null),
    ])
      .then(([ledger, ana]) => {
        setData(ledger.data);
        setAnalytics(ana?.data ?? null);
      })
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [uuid]);

  const receivePayment = async () => {
    const cents = toCents(payAmount);
    if (cents <= 0) return toast('Enter an amount', 'err');
    setBusy(true);
    try {
      await api(`/customers/${uuid}/payments`, {
        method: 'POST',
        body: { amountCents: cents, method: payMethod },
      });
      toast('Payment recorded', 'ok');
      setPayAmount('');
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
      <Modal title="Customer" onClose={onClose}>
        <div className="center" style={{ padding: 30 }}>
          <Spinner />
        </div>
      </Modal>
    );

  const c = data;

  return (
    <Modal title={`${c.customer?.name ?? 'Customer'}`} onClose={onClose} wide>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        {c.customer?.phone && <Badge kind="info">☎ {c.customer.phone}</Badge>}
        {c.customer?.bikes && <Badge>🏍 {c.customer.bikes}</Badge>}
        <Badge kind={c.dueBalance > 0 ? 'bad' : 'ok'}>
          {c.dueBalance > 0 ? `Due ${fmtTaka(c.dueBalance)}` : 'No debt'}
        </Badge>
      </div>

      <div className="tabs">
        <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>
          Debt ledger
        </button>
        <button className={tab === 'analytics' ? 'active' : ''} onClick={() => setTab('analytics')}>
          Purchase analytics
        </button>
      </div>

      {tab === 'ledger' && (
        <>
          {c.dueBalance > 0 && (
            <div className="card" style={{ background: 'var(--red-50)', boxShadow: 'none', marginBottom: 12 }}>
              <div className="card-title">
                <h3>Receive a payment</h3>
                <span className="badge bad">due {fmtTaka(c.dueBalance)}</span>
              </div>
              <div className="row wrap">
                <input
                  className="input"
                  style={{ width: 160 }}
                  inputMode="decimal"
                  placeholder={`amount (max ${(c.dueBalance / 100).toFixed(2)})`}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value.replace(/[^\d.]/g, ''))}
                />
                <select className="input" style={{ width: 130 }} value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  <option value="cash">Cash</option>
                  <option value="bkash">bKash</option>
                  <option value="nagad">Nagad</option>
                  <option value="card">Card</option>
                </select>
                <button className="btn primary" onClick={receivePayment} disabled={busy}>
                  {busy ? <Spinner /> : 'Record payment'}
                </button>
              </div>
            </div>
          )}

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
            <div>
              <h3 style={{ marginBottom: 6 }}>Credit sales</h3>
              <div className="tbl-wrap" style={{ maxHeight: 300 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Date</th>
                      <th className="num">Total</th>
                      <th className="num">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.sales.length === 0 && (
                      <tr><td colSpan={4} className="dim center">No credit sales</td></tr>
                    )}
                    {c.sales.map((s: any) => (
                      <tr key={s.uuid}>
                        <td className="mono">{s.receiptNo}</td>
                        <td className="dim nowrap">{fmtDateTime(s.createdAt)}</td>
                        <td className="num">{fmtTaka(s.totalCents)}</td>
                        <td className="num"><b className="err-text">{fmtTaka(s.dueCents)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 style={{ marginBottom: 6 }}>Payments received</h3>
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
                    {c.payments.length === 0 && (
                      <tr><td colSpan={4} className="dim center">No payments yet</td></tr>
                    )}
                    {c.payments.map((p: any) => (
                      <tr key={p.uuid}>
                        <td className="dim nowrap">{fmtDateTime(p.createdAt)}</td>
                        <td><Badge kind="info">{p.method}</Badge></td>
                        <td className="num" style={{ color: 'var(--green)', fontWeight: 700 }}>
                          −{fmtTaka(p.amountCents)}
                        </td>
                        <td className="dim">{p.userName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'analytics' &&
        (analytics ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div className="card" style={{ boxShadow: 'none' }}>
              <div className="k-label">Purchases</div>
              <div className="k-value">{analytics.totals.visits}</div>
            </div>
            <div className="card" style={{ boxShadow: 'none' }}>
              <div className="k-label">Lifetime spend</div>
              <div className="k-value">{fmtTaka(analytics.totals.totalCents)}</div>
            </div>
            {owner && (
              <div className="card" style={{ boxShadow: 'none' }}>
                <div className="k-label">Profit from this customer</div>
                <div className="k-value" style={{ color: 'var(--green)' }}>
                  {fmtTaka(analytics.totals.totalCents - analytics.totals.cogsCents)}
                </div>
              </div>
            )}

            <div className="card" style={{ gridColumn: '1 / -1', boxShadow: 'none' }}>
              <h3 style={{ marginBottom: 8 }}>What they buy most</h3>
              {analytics.topProducts.length === 0 ? (
                <Empty icon="🛒" title="No sales yet" />
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Qty</th>
                      <th className="num">Spent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topProducts.map((p: any) => (
                      <tr key={p._id}>
                        <td>{p._id}</td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{fmtTaka(p.spent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <Empty icon="📈" title="Analytics unavailable" />
        ))}
    </Modal>
  );
}
