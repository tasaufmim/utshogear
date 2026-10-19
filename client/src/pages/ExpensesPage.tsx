import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';

type Category = { uuid: string; name: string };
type Entry = any;

const bizToday = () => {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dhaka' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

export function ExpensesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('manageExpenses');

  const [cats, setCats] = useState<Category[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(`${bizToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(bizToday());
  const [catFilter, setCatFilter] = useState('');
  const [form, setForm] = useState<{ open: boolean; value: Entry | null }>({ open: false, value: null });
  const [newCat, setNewCat] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api<{ data: Category[] }>('/expenses/categories'),
      api<{ data: Entry[] }>('/expenses', { query: { from, to, categoryId: catFilter } }),
    ])
      .then(([c, e]) => {
        setCats(c.data);
        setEntries(e.data);
      })
      .catch((err) => toast(err.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [from, to, catFilter]);

  const totals = useMemo(() => {
    const byCat: Record<string, number> = {};
    let sum = 0;
    for (const e of entries) {
      sum += e.amountCents;
      byCat[e.categoryName] = (byCat[e.categoryName] || 0) + e.amountCents;
    }
    return { sum, byCat };
  }, [entries]);

  const addCat = async () => {
    const name = newCat.trim();
    if (!name) return;
    try {
      await api('/expenses/categories', { method: 'POST', body: { name } });
      setNewCat('');
      toast('Category added', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Expenses in range</div>
          <div className="k-value">{fmtTaka(totals.sum)}</div>
          <div className="k-delta">
            {from} → {to} · {entries.length} entries
          </div>
        </div>
        {Object.entries(totals.byCat)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([cat, amt]) => (
            <div className="card" key={cat}>
              <div className="k-label">{cat}</div>
              <div className="k-value" style={{ fontSize: 20 }}>{fmtTaka(amt)}</div>
              <div className="k-delta">{Math.round((amt / (totals.sum || 1)) * 100)}% of spend</div>
            </div>
          ))}
      </div>

      <div className="grid mt" style={{ gridTemplateColumns: '1fr 300px', alignItems: 'start' }}>
        <div className="card">
          <div className="card-title">
            <div className="row wrap">
              <input className="input" style={{ width: 160 }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <input className="input" style={{ width: 160 }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              <select className="input" style={{ width: 170 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                <option value="">All categories</option>
                {cats.map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {owner && (
              <button className="btn primary" onClick={() => setForm({ open: true, value: null })}>
                + Add expense
              </button>
            )}
          </div>

          {loading ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <Empty icon="💸" title="No expenses logged" hint="Daily costing: rent, salary, tea, transport, utilities…" />
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: '60vh' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Note</th>
                    <th>Method</th>
                    <th className="num">Amount</th>
                    <th>By</th>
                    {owner && <th style={{ width: 90 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.uuid}>
                      <td className="dim nowrap">{e.date}</td>
                      <td>
                        <Badge kind="warn">{e.categoryName}</Badge>
                      </td>
                      <td className="dim">{e.note || '—'}</td>
                      <td className="dim">{e.method}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtTaka(e.amountCents)}
                      </td>
                      <td className="dim">{e.userName}</td>
                      {owner && (
                        <td className="right nowrap">
                          <button className="btn sm" onClick={() => setForm({ open: true, value: e })}>
                            Edit
                          </button>{' '}
                          <button
                            className="btn sm"
                            onClick={async () => {
                              if (!confirm('Delete this expense entry? The deletion is audited.')) return;
                              try {
                                await api(`/expenses/${e.uuid}`, { method: 'DELETE' });
                                toast('Entry deleted (audited)', 'ok');
                                load();
                              } catch (err: any) {
                                toast(err.message, 'err');
                              }
                            }}
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* categories */}
        <div className="card" style={{ position: 'sticky', top: 0 }}>
          <div className="card-title">
            <h3>Categories</h3>
          </div>
          <div className="grid" style={{ gap: 6 }}>
            {cats.map((c) => (
              <div key={c.uuid} className="between" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                <span>{c.name}</span>
                <span className="dim">{totals.byCat[c.name] ? fmtTaka(totals.byCat[c.name]) : ''}</span>
              </div>
            ))}
          </div>
          {owner && (
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="input"
                placeholder="new category…"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addCat()}
              />
              <button className="btn" onClick={addCat}>
                +
              </button>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            Daily costing feeds the profit report: net = sales − cost − these expenses.
          </p>
        </div>
      </div>

      {form.open && (
        <ExpenseForm
          cats={cats}
          value={form.value}
          onClose={() => setForm({ open: false, value: null })}
          onSaved={() => {
            setForm({ open: false, value: null });
            load();
          }}
        />
      )}
    </>
  );
}

function ExpenseForm({
  cats,
  value,
  onClose,
  onSaved,
}: {
  cats: Category[];
  value: Entry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!value;
  const [f, setF] = useState({
    date: value?.date ?? bizToday(),
    categoryId: value?.categoryId ?? cats[0]?.uuid ?? '',
    amount: value ? String(value.amountCents / 100) : '',
    method: value?.method ?? 'cash',
    note: value?.note ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const cents = toCents(f.amount);
    if (cents <= 0) return toast('Enter an amount', 'err');
    if (!f.categoryId) return toast('Pick a category', 'err');
    setBusy(true);
    try {
      const body = { ...f, amountCents: cents };
      if (isEdit) await api(`/expenses/${value.uuid}`, { method: 'PATCH', body });
      else await api('/expenses', { method: 'POST', body });
      toast(isEdit ? 'Entry updated' : 'Expense logged', 'ok');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit expense' : 'New expense'}
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
          <label>Date *</label>
          <input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </div>
        <div className="field">
          <label>Category *</label>
          <select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            {cats.map((c) => (
              <option key={c.uuid} value={c.uuid}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Amount (৳) *</label>
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={f.amount}
            placeholder="0"
            onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })}
          />
        </div>
        <div className="field">
          <label>Paid via</label>
          <select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="cash">Cash</option>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
            <option value="card">Card</option>
          </select>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Note</label>
          <input className="input" placeholder="shop rent Oct, staff salary, delivery charge…" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}
