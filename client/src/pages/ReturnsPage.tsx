import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';
import { Receipt } from '../components/Receipt';
import { OwnerPinModal } from './PosPage';

type Sale = any;
type Settings = any;

export function ReturnsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'new' | 'history'>('new');
  const [settings, setSettings] = useState<Settings | null>(null);

  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);

  useEffect(() => {
    api<{ data: Settings }>('/settings').then((r) => setSettings(r.data)).catch(() => {});
  }, []);

  return (
    <>
      <div className="tabs">
        <button className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>
          ↩ New return / exchange
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          🕘 Return history
        </button>
      </div>

      {tab === 'new' ? (
        <ReturnForm settings={settings} onReceipt={setReceiptSale} onDone={() => setTab('history')} />
      ) : (
        <History />
      )}

      {receiptSale && (
        <Receipt
          sale={receiptSale}
          settings={settings}
          mode="reprint"
          autoPrint={false}
          onDone={() => setReceiptSale(null)}
        />
      )}
    </>
  );
}

/* ===================================================================== *
 *  RETURN / EXCHANGE FORM
 * ===================================================================== */
function ReturnForm({
  settings,
  onReceipt,
  onDone,
}: {
  settings: Settings | null;
  onReceipt: (s: Sale) => void;
  onDone: () => void;
}) {
  const toast = useToast();

  const [receiptQuery, setReceiptQuery] = useState('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [fetching, setFetching] = useState(false);

  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<'cash' | 'original' | 'due_adjust'>('cash');

  const [exLines, setExLines] = useState<{ key: string; productId: string; sku: string; name: string; qty: number; unitPrice: number }[]>([]);
  const [exQuery, setExQuery] = useState('');
  const [exResults, setExResults] = useState<any[]>([]);
  const exSearchRef = useRef<HTMLInputElement>(null);

  const [extraTaka, setExtraTaka] = useState('');
  const [busy, setBusy] = useState(false);
  const [pinFor, setPinFor] = useState<null | { run: (pin?: string) => Promise<void> }>(null);

  const windowDays = Number(settings?.returnWindowDays ?? 7);

  const loadSale = async () => {
    if (!receiptQuery.trim()) return;
    setFetching(true);
    try {
      const r = await api<{ data: Sale }>(`/sales/${receiptQuery.trim()}`);
      setSale(r.data);
      setQtys({});
      setReasons({});
      setRestock({});
      setMethod(r.data.customerId ? 'cash' : 'cash');
      setExLines([]);
      setExtraTaka('');
    } catch (e: any) {
      toast(e.message, 'err');
      setSale(null);
    } finally {
      setFetching(false);
    }
  };

  const ageDays = sale ? Math.floor((Date.now() - Date.parse(sale.createdAt)) / 86_400_000) : 0;
  const outOfWindow = sale ? windowDays > 0 && ageDays > windowDays : false;

  /* -------- exchange product search -------- */
  useEffect(() => {
    const t = setTimeout(() => {
      if (!exQuery.trim()) return setExResults([]);
      api<{ data: any[] }>('/products/search', { query: { q: exQuery, limit: 10 } })
        .then((r) => setExResults(r.data))
        .catch(() => {});
    }, 160);
    return () => clearTimeout(t);
  }, [exQuery]);

  const addEx = (p: any) => {
    setExLines((prev) => {
      const found = prev.find((l) => l.productId === p.uuid);
      if (found) return prev.map((l) => (l.productId === p.uuid ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...prev,
        { key: `${p.uuid}-${Date.now()}`, productId: p.uuid, sku: p.sku, name: p.name, qty: 1, unitPrice: p.sellPrice },
      ];
    });
    setExQuery('');
    setExResults([]);
    exSearchRef.current?.focus();
  };

  /* -------- money -------- */
  const refundLines = useMemo(() => {
    if (!sale) return [];
    return sale.lines
      .map((l: any) => {
        const qty = Number(qtys[l.productId]) || 0;
        const unitRefund = Math.round(l.lineTotal / l.qty);
        return { ...l, retQty: qty, unitRefund, refund: unitRefund * qty };
      })
      .filter((l: any) => l.retQty > 0);
  }, [sale, qtys]);

  const refundCents = refundLines.reduce((s: number, l: any) => s + l.refund, 0);
  const exTotal = exLines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const isExchange = exLines.length > 0;
  const diff = refundCents - exTotal;
  const extraDefault = Math.max(0, exTotal - refundCents);
  const cashBack = !isExchange ? refundCents : Math.max(0, diff);
  const extraCents = isExchange ? toCents(extraTaka || '0') : 0;

  const submit = async (pin?: string) => {
    if (!sale) return toast('Load a receipt first', 'err');
    if (refundLines.length === 0) return toast('Set quantities on the items being returned', 'err');

    setBusy(true);
    try {
      const body: any = {
        saleUuid: sale.uuid,
        lines: refundLines.map((l: any) => ({
          productId: l.productId,
          qty: l.retQty,
          reason: reasons[l.productId] || undefined,
          restock: restock[l.productId] !== false,
        })),
        method,
      };
      if (isExchange) {
        body.exchangeLines = exLines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice }));
        body.extraPaidCents = extraCents || extraDefault;
        body.exchangeClientTxnId = crypto.randomUUID();
      }

      const r = await api<any>('/returns', {
        method: 'POST',
        body,
        headers: pin ? { 'x-owner-pin': pin } : undefined,
      });

      const ret = r.data.return;
      toast(`${ret.returnNo} — refunded ${fmtTaka(ret.refundCents)}${isExchange ? ' · exchange completed' : ''}`, 'ok');

      if (r.data.sale) onReceipt(r.data.sale); // print the exchange receipt
      setSale(null);
      setReceiptQuery('');
      setQtys({});
      setExLines([]);
      if (!r.data.sale) onDone();
    } catch (e: any) {
      if (e?.code === 'RETURN_WINDOW' || /owner PIN/i.test(e?.message ?? '')) {
        toast(e.message, 'err');
        setPinFor({ run: (p) => submit(p) });
      } else {
        toast(e?.message ?? 'Return failed', 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 320px', alignItems: 'start' }}>
      <div className="grid" style={{ gap: 12 }}>
        {/* ---- step 1: find the receipt ---- */}
        <div className="card" style={{ padding: 12 }}>
          <div className="row">
            <input
              className="input"
              style={{ fontSize: 15, padding: '10px 12px' }}
              placeholder="Receipt number (UGR-2026-000123) — or scan it…"
              value={receiptQuery}
              onChange={(e) => setReceiptQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadSale()}
            />
            <button className="btn primary" onClick={loadSale} disabled={fetching || !receiptQuery.trim()}>
              {fetching ? <Spinner /> : 'Find'}
            </button>
          </div>
        </div>

        {/* ---- step 2: pick lines ---- */}
        {sale && (
          <div className="card">
            <div className="card-title">
              <h2>
                {sale.receiptNo} <span className="dim">· {fmtDateTime(sale.createdAt)} · {sale.customerName}</span>
              </h2>
              <div className="row">
                {outOfWindow && <Badge kind="bad">past {windowDays}-day window — owner PIN</Badge>}
                <Badge kind="info">{fmtTaka(sale.totalCents)}</Badge>
              </div>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Paid each</th>
                    <th style={{ width: 90 }}>Return qty</th>
                    <th style={{ width: 90 }}>Restock</th>
                    <th style={{ width: 170 }}>Reason</th>
                    <th className="num" style={{ width: 110 }}>
                      Refund
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sale.lines.map((l: any) => {
                    const qty = Number(qtys[l.productId]) || 0;
                    const unitRefund = Math.round(l.lineTotal / l.qty);
                    return (
                      <tr key={l.productId} style={qty > 0 ? { background: 'var(--brand-50)' } : undefined}>
                        <td>
                          <div style={{ fontWeight: 650 }}>
                            {l.name} {l.size && <span className="badge">{l.size}</span>}
                          </div>
                          <div className="dim" style={{ fontSize: 11 }}>
                            sold {l.qty}
                          </div>
                        </td>
                        <td className="num dim">{fmtTaka(unitRefund)}</td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={l.qty}
                            style={{ padding: '6px 6px' }}
                            value={qtys[l.productId] ?? ''}
                            placeholder="0"
                            onChange={(e) => setQtys((p) => ({ ...p, [l.productId]: e.target.value.replace(/\D/g, '') }))}
                          />
                        </td>
                        <td className="center">
                          <input
                            type="checkbox"
                            checked={restock[l.productId] !== false}
                            onChange={(e) => setRestock((p) => ({ ...p, [l.productId]: e.target.checked }))}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: '6px 6px' }}
                            placeholder="optional"
                            value={reasons[l.productId] ?? ''}
                            onChange={(e) => setReasons((p) => ({ ...p, [l.productId]: e.target.value }))}
                          />
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {qty > 0 ? fmtTaka(unitRefund * qty) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Refunds use the price actually paid — a discounted item refunds the discounted amount.
              Untick <b>Restock</b> for damaged goods (money back, but no stock in).
            </p>
          </div>
        )}

        {/* ---- exchange lines ---- */}
        {sale && (
          <div className="card" style={{ position: 'relative' }}>
            <div className="card-title">
              <h2>Exchange for (optional)</h2>
            </div>
            <input
              ref={exSearchRef}
              className="input"
              placeholder="Add replacement item — scan or search…"
              value={exQuery}
              onChange={(e) => setExQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && exResults.length) {
                  e.preventDefault();
                  addEx(exResults[0]);
                }
              }}
            />
            {exResults.length > 0 && (
              <div className="tbl-wrap" style={{ maxHeight: 200, marginTop: 6, boxShadow: 'var(--shadow-lg)' }}>
                <table className="tbl">
                  <tbody>
                    {exResults.map((p) => (
                      <tr key={p.uuid} style={{ cursor: 'pointer' }} onClick={() => addEx(p)}>
                        <td>
                          <b>{p.name}</b> <span className="dim">{p.sku}</span>
                        </td>
                        <td className="num">{fmtTaka(p.sellPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {exLines.length > 0 && (
              <table className="tbl" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ width: 90 }}>Qty</th>
                    <th style={{ width: 130 }}>Price</th>
                    <th className="num" style={{ width: 110 }}>
                      Total
                    </th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {exLines.map((l) => (
                    <tr key={l.key}>
                      <td style={{ fontWeight: 650 }}>{l.name}</td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          style={{ padding: '6px 6px' }}
                          value={l.qty}
                          onChange={(e) =>
                            setExLines((p) =>
                              p.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x))
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          inputMode="decimal"
                          style={{ padding: '6px 6px' }}
                          value={String(l.unitPrice / 100)}
                          onChange={(e) =>
                            setExLines((p) =>
                              p.map((x) => (x.key === l.key ? { ...x, unitPrice: toCents(e.target.value) } : x))
                            )
                          }
                        />
                      </td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtTaka(l.unitPrice * l.qty)}
                      </td>
                      <td>
                        <button className="btn ghost sm" onClick={() => setExLines((p) => p.filter((x) => x.key !== l.key))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ---- summary panel ---- */}
      <div className="card" style={{ position: 'sticky', top: 0 }}>
        {!sale ? (
          <Empty icon="↩" title="No receipt loaded" hint="Type the receipt number to start a return" />
        ) : (
          <>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Money back as</label>
              <div className="row wrap">
                {(['cash', 'original', 'due_adjust'] as const).map((m) => (
                  <button key={m} className={`btn sm ${method === m ? 'primary' : ''}`} onClick={() => setMethod(m)} disabled={m === 'due_adjust' && !sale.customerId}>
                    {m === 'due_adjust' ? 'Reduce debt' : m === 'original' ? 'Original method' : 'Cash'}
                  </button>
                ))}
              </div>
              {method === 'due_adjust' && <span className="hint">adds the refund back to the customer's paid amount, lowering their due</span>}
            </div>

            <div className="between dim">
              <span>Items returning</span>
              <span>{refundLines.reduce((s: number, l: any) => s + l.retQty, 0) || 0}</span>
            </div>
            <div className="between dim">
              <span>Refund due</span>
              <span>{fmtTaka(refundCents)}</span>
            </div>
            {isExchange && (
              <div className="between dim">
                <span>Exchange items</span>
                <span>−{fmtTaka(exTotal)}</span>
              </div>
            )}
            <div
              className="between"
              style={{ borderTop: '2px solid var(--text)', paddingTop: 8, marginTop: 8, fontSize: 22, fontWeight: 800 }}
            >
              <span>{cashBack > 0 ? 'Cash back' : isExchange && diff < 0 ? 'To collect' : 'Refund'}</span>
              <span style={{ color: diff < 0 && isExchange ? 'var(--red)' : undefined }}>
                {fmtTaka(isExchange ? Math.abs(diff) : refundCents)}
              </span>
            </div>

            {isExchange && diff >= 0 && (
              <div className="field" style={{ marginTop: 10 }}>
                <label>Handed over extra cash (for change)</label>
                <input
                  className="input"
                  inputMode="decimal"
                  placeholder={String(extraDefault / 100)}
                  value={extraTaka}
                  onChange={(e) => setExtraTaka(e.target.value.replace(/[^\d.]/g, ''))}
                />
              </div>
            )}

            <button
              className="btn primary lg block"
              style={{ marginTop: 12 }}
              disabled={busy || refundLines.length === 0}
              onClick={() => submit()}
            >
              {busy ? <Spinner /> : isExchange ? 'Complete exchange' : `Refund ${fmtTaka(refundCents)}`}
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              Returns are permanent and audited. Past the return window the owner PIN is requested.
            </p>
          </>
        )}
      </div>

      {pinFor && (
        <OwnerPinModal
          action="Approve return"
          onClose={() => setPinFor(null)}
          onSubmit={async (pin) => {
            try {
              await pinFor.run(pin);
              setPinFor(null);
            } catch (e: any) {
              toast(e?.message ?? 'Incorrect PIN', 'err');
            }
          }}
        />
      )}
    </div>
  );
}

/* ===================================================================== *
 *  HISTORY
 * ===================================================================== */
function History() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('viewCost');

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [detail, setDetail] = useState<any>(null);

  const load = () => {
    setLoading(true);
    api<{ data: any[] }>('/returns', { query: { q, from, to, limit: 60 } })
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [from, to]);

  return (
    <div className="card">
      <div className="card-title">
        <div className="row wrap">
          <input
            className="input"
            style={{ width: 240 }}
            placeholder="UGRR #, receipt #, customer…"
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
        <Empty icon="↩" title="No returns recorded" hint="Refunds and exchanges show up here permanently" />
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: '62vh' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Return #</th>
                <th>When</th>
                <th>Original receipt</th>
                <th>Customer</th>
                <th className="num">Refund</th>
                <th>Method</th>
                <th>Type</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.uuid} style={{ cursor: 'pointer' }} onClick={() => setDetail(r)}>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {r.returnNo}
                  </td>
                  <td className="dim nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td className="mono">{r.receiptNo}</td>
                  <td>{r.customerName}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    −{fmtTaka(r.refundCents)}
                  </td>
                  <td>
                    <Badge kind={r.method === 'due_adjust' ? 'warn' : 'info'}>{r.method.replace('_', ' ')}</Badge>
                  </td>
                  <td>
                    {r.isExchange ? <Badge kind="ok">exchange</Badge> : <Badge>return</Badge>}
                  </td>
                  <td className="dim">{r.userName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <Modal title={`${detail.returnNo} — refund of ${fmtTaka(detail.refundCents)}`} onClose={() => setDetail(null)} wide>
          <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
            <Badge kind="info">from {detail.receiptNo}</Badge>
            <Badge>{detail.method.replace('_', ' ')}</Badge>
            {detail.isExchange && <Badge kind="ok">exchange · {detail.exchangeSaleUuid ? 'receipt issued' : ''}</Badge>}
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Refund each</th>
                <th>Restock</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 650 }}>{l.name}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{fmtTaka(l.unitPrice)}</td>
                  <td>{l.restock ? <Badge kind="ok">yes</Badge> : <Badge kind="bad">no — damaged</Badge>}</td>
                  <td className="dim">{l.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint mt">Handled by {detail.userName} · {fmtDateTime(detail.createdAt)}</p>
        </Modal>
      )}
    </div>
  );
}
