import React, { useEffect, useRef, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';

type Product = any;
type Supplier = any;
type Purchase = any;

export function PurchasesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('manageProducts');

  const [tab, setTab] = useState<'new' | 'history'>('new');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [detail, setDetail] = useState<Purchase | null>(null);

  useEffect(() => {
    api<{ data: Supplier[] }>('/suppliers').then((r) => setSuppliers(r.data)).catch(() => {});
  }, []);

  return (
    <>
      <div className="tabs">
        <button className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>
          + Receive stock
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          🕘 Purchase history
        </button>
        {!owner && (
          <span className="dim" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
            Only the owner records purchases (they change costs)
          </span>
        )}
      </div>

      {tab === 'new' ? (
        <GrnForm
          suppliers={suppliers}
          onSuppliersChanged={() => api<{ data: Supplier[] }>('/suppliers').then((r) => setSuppliers(r.data))}
          onDone={() => setTab('history')}
        />
      ) : (
        <History onOpen={setDetail} />
      )}

      {detail && <PurchaseDetail purchase={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/* ===================================================================== *
 *  GOODS RECEIVED NOTE
 * ===================================================================== */
function GrnForm({
  suppliers,
  onSuppliersChanged,
  onDone,
}: {
  suppliers: Supplier[];
  onSuppliersChanged: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('manageProducts');

  const [supplierId, setSupplierId] = useState('');
  const [supplierInvoice, setSupplierInvoice] = useState('');
  const [lines, setLines] = useState<{ key: string; productId: string; sku: string; name: string; qty: string; price: string }[]>([]);
  const [extra, setExtra] = useState('');
  const [method, setMethod] = useState<'cash' | 'bkash' | 'nagad' | 'card' | 'credit'>('cash');
  const [paidTaka, setPaidTaka] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [pq, setPq] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [showRes, setShowRes] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!pq.trim()) return setResults([]);
      api<{ data: Product[] }>('/products/search', { query: { q: pq, limit: 12 } })
        .then((r) => {
          setResults(r.data);
          setShowRes(true);
        })
        .catch(() => {});
    }, 160);
    return () => clearTimeout(t);
  }, [pq]);

  const addLine = (p: Product) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.uuid);
      if (existing) {
        return prev.map((l) => (l.productId === p.uuid ? { ...l, qty: String(Number(l.qty) + 1) } : l));
      }
      return [
        ...prev,
        {
          key: `${p.uuid}-${Date.now()}`,
          productId: p.uuid,
          sku: p.sku,
          name: p.name,
          qty: '1',
          // prefill last purchase price — the owner edits it if this order differs
          price: p.lastPurchasePrice ? String(p.lastPurchasePrice / 100) : '',
        },
      ];
    });
    setPq('');
    setResults([]);
    searchRef.current?.focus();
  };

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * toCents(l.price || '0'), 0);
  const extraC = toCents(extra || '0');
  const grand = subtotal + extraC;
  const paidC = method === 'credit' ? 0 : paidTaka ? Math.min(toCents(paidTaka), grand) : grand;
  const dueC = grand - paidC;

  const submit = async () => {
    if (!owner) return toast('Owner only', 'err');
    if (lines.length === 0) return toast('Add at least one line', 'err');
    if (lines.some((l) => !(Number(l.qty) > 0))) return toast('Every line needs a quantity', 'err');
    if (lines.some((l) => l.price === '')) return toast('Every line needs a unit price', 'err');
    if (dueC > 0 && !supplierId) return toast('A due payment needs a supplier', 'err');

    setBusy(true);
    try {
      const r = await api<{ data: Purchase }>('/purchases', {
        method: 'POST',
        body: {
          supplierId: supplierId || null,
          supplierInvoice,
          lines: lines.map((l) => ({
            productId: l.productId,
            qty: Number(l.qty),
            unitPrice: toCents(l.price),
          })),
          extraCostCents: extraC,
          paymentMethod: method,
          paidCents: paidC,
          note,
        },
      });
      toast(`${r.data.ref} recorded — stock and average cost updated`, 'ok');
      setLines([]);
      setExtra('');
      setPaidTaka('');
      setSupplierInvoice('');
      setNote('');
      onDone();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!owner) return <Empty icon="🔒" title="Owner only" hint="Purchases change product costs — owner records them" />;

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 320px', alignItems: 'start' }}>
      <div className="card" style={{ position: 'relative' }}>
        <div className="card-title">
          <h2>Receive stock</h2>
        </div>

        <div className="row wrap" style={{ marginBottom: 12 }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Supplier</label>
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— walk-in / cash supplier —</option>
              {suppliers.map((s) => (
                <option key={s.uuid} value={s.uuid}>
                  {s.name} {s.dueBalance > 0 ? `(owe ${fmtTaka(s.dueBalance)})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label>Supplier invoice #</label>
            <input className="input" value={supplierInvoice} onChange={(e) => setSupplierInvoice(e.target.value)} placeholder="optional" />
          </div>
        </div>

        {/* product search */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <input
            ref={searchRef}
            className="input"
            placeholder="Add product — scan barcode or type name…"
            value={pq}
            onChange={(e) => setPq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length) {
                e.preventDefault();
                addLine(results.find((r) => r.barcode === pq.trim()) ?? results[0]);
              }
            }}
          />
          {showRes && results.length > 0 && (
            <div className="tbl-wrap" style={{ position: 'absolute', left: 0, right: 0, top: 46, zIndex: 20, maxHeight: 240, boxShadow: 'var(--shadow-lg)' }}>
              <table className="tbl">
                <tbody>
                  {results.map((p) => (
                    <tr key={p.uuid} style={{ cursor: 'pointer' }} onClick={() => addLine(p)}>
                      <td>
                        <b>{p.name}</b> {p.size && <span className="badge">{p.size}</span>}
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {p.barcode} · {p.sku} · stock {p.stock}
                        </div>
                      </td>
                      <td className="num dim">last {fmtTaka(p.lastPurchasePrice || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {lines.length === 0 ? (
          <Empty icon="📥" title="No lines yet" hint="Scan each item's barcode — price prefills from last purchase" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ width: 96 }}>Qty</th>
                  <th style={{ width: 140 }}>Unit price (৳)</th>
                  <th className="num" style={{ width: 120 }}>
                    Line total
                  </th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      <div style={{ fontWeight: 650 }}>{l.name}</div>
                      <div className="dim mono" style={{ fontSize: 11 }}>
                        {l.sku}
                      </div>
                    </td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        style={{ padding: '6px 6px' }}
                        value={l.qty}
                        onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        inputMode="decimal"
                        style={{ padding: '6px 6px' }}
                        value={l.price}
                        placeholder="0"
                        onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, price: e.target.value.replace(/[^\d.]/g, '') } : x)))}
                      />
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtTaka((Number(l.qty) || 0) * toCents(l.price || '0'))}
                    </td>
                    <td>
                      <button className="btn ghost sm" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* summary panel */}
      <div className="card" style={{ position: 'sticky', top: 0 }}>
        <div className="between dim">
          <span>Subtotal</span>
          <span>{fmtTaka(subtotal)}</span>
        </div>
        <div className="row" style={{ margin: '8px 0' }}>
          <span className="dim" style={{ flex: 1 }}>
            Freight / extra cost
          </span>
          <input
            className="input"
            style={{ width: 110 }}
            inputMode="decimal"
            placeholder="0"
            value={extra}
            onChange={(e) => setExtra(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </div>
        <p className="hint" style={{ marginTop: -4 }}>
          Spread across lines by value → lands in average cost.
        </p>
        <div
          className="between"
          style={{ borderTop: '2px solid var(--text)', paddingTop: 8, marginTop: 8, fontSize: 24, fontWeight: 800 }}
        >
          <span>TOTAL</span>
          <span>{fmtTaka(grand)}</span>
        </div>

        <div className="row wrap" style={{ margin: '12px 0 8px' }}>
          {(['cash', 'bkash', 'nagad', 'credit'] as const).map((m) => (
            <button key={m} className={`btn sm ${method === m ? 'primary' : ''}`} onClick={() => setMethod(m)}>
              {m === 'credit' ? 'On credit (due)' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {method !== 'credit' && (
          <div className="field" style={{ marginBottom: 8 }}>
            <label>Paid now</label>
            <input
              className="input"
              inputMode="decimal"
              placeholder={String(grand / 100)}
              value={paidTaka}
              onChange={(e) => setPaidTaka(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </div>
        )}
        {dueC > 0 && (
          <div className="between" style={{ background: 'var(--red-50)', padding: '7px 10px', borderRadius: 7 }}>
            <span className="dim">Due to supplier</span>
            <b className="err-text">{fmtTaka(dueC)}</b>
          </div>
        )}

        <div className="field" style={{ marginTop: 10 }}>
          <label>Note</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <button className="btn primary lg block" style={{ marginTop: 12 }} disabled={busy || lines.length === 0} onClick={submit}>
          {busy ? <Spinner /> : `Receive ${lines.length} line${lines.length === 1 ? '' : 's'} · ${fmtTaka(grand)}`}
        </button>
      </div>
    </div>
  );
}

/* ===================================================================== *
 *  HISTORY
 * ===================================================================== */
function History({ onOpen }: { onOpen: (p: Purchase) => void }) {
  const toast = useToast();
  const [items, setItems] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = () => {
    setLoading(true);
    api<{ data: Purchase[] }>('/purchases', { query: { q, from, to, limit: 60 } })
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to]);

  return (
    <div className="card">
      <div className="card-title">
        <div className="row wrap">
          <input
            className="input"
            style={{ width: 230 }}
            placeholder="PUR ref, supplier…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <input className="input" style={{ width: 160 }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input" style={{ width: 160 }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="btn sm" onClick={load}>
          ↻
        </button>
      </div>
      {loading ? (
        <div className="center" style={{ padding: 30 }}>
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Empty icon="🕘" title="No purchases recorded yet" />
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: '62vh' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Ref</th>
                <th>When</th>
                <th>Supplier</th>
                <th className="num">Lines</th>
                <th className="num">Total</th>
                <th className="num">Due</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.uuid} style={{ cursor: 'pointer' }} onClick={() => onOpen(p)}>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {p.ref}
                  </td>
                  <td className="dim nowrap">{fmtDateTime(p.createdAt)}</td>
                  <td>{p.supplierName}</td>
                  <td className="num">{p.lines.length}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtTaka(p.grandTotalCents)}
                  </td>
                  <td className="num">{p.dueCents > 0 ? <Badge kind="bad">{fmtTaka(p.dueCents)}</Badge> : <span className="dim">—</span>}</td>
                  <td className="right">
                    <button className="btn sm">Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ===================================================================== *
 *  DETAIL
 * ===================================================================== */
function PurchaseDetail({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const p = purchase;
  return (
    <Modal title={`${p.ref} · ${p.supplierName}`} onClose={onClose} wide>
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <Badge kind="info">{fmtDateTime(p.createdAt)}</Badge>
        {p.supplierInvoice && <Badge>invoice {p.supplierInvoice}</Badge>}
        <Badge kind={p.dueCents > 0 ? 'bad' : 'ok'}>{p.dueCents > 0 ? `due ${fmtTaka(p.dueCents)}` : 'settled'}</Badge>
        <Badge>{p.paymentMethod}</Badge>
      </div>

      <table className="tbl">
        <thead>
          <tr>
            <th>Product</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Freight share</th>
            <th className="num">Landed cost</th>
            <th className="num">Line total</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l: any, i: number) => (
            <tr key={i}>
              <td>
                <b>{l.name}</b>
                <div className="dim mono" style={{ fontSize: 11 }}>
                  {l.sku}
                </div>
              </td>
              <td className="num">{l.qty}</td>
              <td className="num">{fmtTaka(l.unitPrice)}</td>
              <td className="num dim">{l.extraAlloc ? `+${fmtTaka(l.extraAlloc)}` : '—'}</td>
              <td className="num">
                <b>{fmtTaka(l.unitCost)}</b>
              </td>
              <td className="num">{fmtTaka(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="right" style={{ marginTop: 12, display: 'grid', gap: 4 }}>
        <div className="between dim">
          <span>Subtotal</span>
          <span>{fmtTaka(p.subtotalCents)}</span>
        </div>
        {p.extraCostCents > 0 && (
          <div className="between dim">
            <span>Freight / extra</span>
            <span>+{fmtTaka(p.extraCostCents)}</span>
          </div>
        )}
        <div className="between" style={{ fontWeight: 800, fontSize: 17 }}>
          <span>Grand total</span>
          <span>{fmtTaka(p.grandTotalCents)}</span>
        </div>
        <div className="between dim">
          <span>Paid</span>
          <span>{fmtTaka(p.paidCents)}</span>
        </div>
      </div>

      {p.note && <p className="hint mt">Note: {p.note}</p>}
    </Modal>
  );
}
