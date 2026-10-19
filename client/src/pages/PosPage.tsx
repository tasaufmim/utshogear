import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge } from '../ui';
import { useAuth } from '../auth';
import { Receipt } from '../components/Receipt';
import { bizToday } from './DashboardPage';

type Product = any;
type CartLine = {
  key: string;
  productId: string;
  sku: string;
  name: string;
  size: string;
  qty: number;
  unitPrice: number; // cents
  floorPrice: number;
  stock: number;
  lineDiscount: { type: 'pct' | 'amt'; val: number } | null;
};

type Customer = any;
type Sale = any;
type Park = any;
type Settings = any;

const takaToCents = (v: string) => toCents(v);
const centsToTaka = (v: number) => (v === 0 ? '' : String(v / 100));

export function PosPage() {
  const toast = useToast();
  const { user, can } = useAuth();
  const owner = can('viewCost');

  /* ------------------------------- state ------------------------------- */
  const [settings, setSettings] = useState<Settings | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderDiscType, setOrderDiscType] = useState<'pct' | 'amt'>('amt');
  const [orderDiscVal, setOrderDiscVal] = useState('');

  const [method, setMethod] = useState<'cash' | 'bkash' | 'nagad' | 'due'>('cash');
  const [paidTaka, setPaidTaka] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [custQuery, setCustQuery] = useState('');
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [newCust, setNewCust] = useState<{ name: string; phone: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [autoPrintOnOpen, setAutoPrintOnOpen] = useState(false);
  const [receiptMode, setReceiptMode] = useState<'checkout' | 'reprint'>('checkout');
  const [pinFor, setPinFor] = useState<null | { action: string; run: (pin?: string) => Promise<void> }>(null);

  const [parks, setParks] = useState<Park[]>([]);
  const [showRecall, setShowRecall] = useState(false);

  const [tab, setTab] = useState<'sell' | 'history'>('sell');
  const [hist, setHist] = useState<Sale[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histQ, setHistQ] = useState('');
  // History defaults to the Asia/Dhaka BUSINESS date (same rule as the API);
  // a plain UTC date hides evening sales (Dhaka is UTC+6).
  const [histFrom, setHistFrom] = useState(bizToday());
  const [histTo, setHistTo] = useState(bizToday());
  const [histPage, setHistPage] = useState(1);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const paidRef = useRef<HTMLInputElement>(null);

  /* --------------------------- reference data -------------------------- */
  useEffect(() => {
    api<{ data: Settings }>('/settings').then((r) => setSettings(r.data)).catch(() => {});
    loadParks();
  }, []);

  const loadParks = () =>
    api<{ data: Park[] }>('/parks').then((r) => setParks(r.data)).catch(() => {});

  /* ------------------------------- search ------------------------------ */
  const runSearch = useCallback(async (term: string) => {
    if (!term.trim()) {
      setResults([]);
      setShowResults(false);
      return;
    }
    setSearching(true);
    try {
      const r = await api<{ data: Product[] }>('/products/search', { query: { q: term, limit: 25 } });
      setResults(r.data);
      setShowResults(true);
    } catch {
      /* offline/err — keep last results */
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runSearch(q), 180);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  /* ------------------------------- customer ---------------------------- */
  useEffect(() => {
    const t = setTimeout(() => {
      if (!custQuery.trim()) return setCustResults([]);
      api<{ data: Customer[] }>('/customers', { query: { q: custQuery, limit: 8 } })
        .then((r) => setCustResults(r.data))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [custQuery]);

  /* ------------------------------ cart math ---------------------------- */
  const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const lineDiscTotal = cart.reduce((s, l) => s + discountAmount(l.lineDiscount, l.unitPrice * l.qty), 0);
  const afterLines = subtotal - lineDiscTotal;
  const orderDisc = orderDiscVal ? discountAmount({ type: orderDiscType, val: Number(orderDiscVal) || 0 }, afterLines) : 0;
  const total = Math.max(0, afterLines - orderDisc);

  const paidCents = method === 'cash' ? (paidTaka ? takaToCents(paidTaka) : total) : method === 'due' ? 0 : total;
  const change = method === 'cash' && paidCents > total ? paidCents - total : 0;
  const due = method === 'due' ? total : method === 'cash' && paidCents < total ? total - paidCents : 0;

  const lowStockLine = cart.find((l) => l.qty > l.stock);

  /* ------------------------------ add items ---------------------------- */
  const addProduct = (p: Product) => {
    const existing = cart.find((l) => l.productId === p.uuid);
    const currentQty = existing?.qty ?? 0;
    if (currentQty + 1 > p.stock) {
      toast(`Only ${p.stock} × "${p.name}" in stock`, 'err');
      if (p.stock <= 0) return;
    }
    setCart((prev) => {
      if (existing) {
        return prev.map((l) =>
          l.key === existing.key ? { ...l, qty: Math.min(l.qty + 1, p.stock) } : l
        );
      }
      return [
        ...prev,
        {
          key: `${p.uuid}-${Date.now()}`,
          productId: p.uuid,
          sku: p.sku,
          name: p.name,
          size: p.size ?? '',
          qty: 1,
          unitPrice: p.sellPrice,
          floorPrice: p.floorPrice ?? 0,
          stock: p.stock,
          lineDiscount: null,
        },
      ];
    });
    setShowResults(false);
    setQ('');
    setResults([]);
    searchRef.current?.focus();
  };

  const commitSearch = () => {
    if (!q.trim() || results.length === 0) return;
    // exact barcode/sku match first, else top result
    const exact =
      results.find((r) => r.barcode === q.trim()) ||
      results.find((r) => r.sku === q.trim().toUpperCase()) ||
      results[0];
    addProduct(exact);
  };

  const setLine = (key: string, patch: Partial<CartLine>) =>
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => setCart((prev) => prev.filter((l) => l.key !== key));

  const clearSale = () => {
    setCart([]);
    setOrderDiscVal('');
    setPaidTaka('');
    setMethod('cash');
    setCustomer(null);
    setCustQuery('');
    searchRef.current?.focus();
  };

  /* ------------------------------ shortcuts ---------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        if (receiptSale) closeReceipt();
        else clearSale();
      }
      if (e.key === 'F4') {
        e.preventDefault();
        setTab('sell');
        searchRef.current?.focus();
      }
      if (e.key === 'F6') {
        e.preventDefault();
        if (cart.length) hold();
      }
      if (e.key === 'Escape') {
        setShowResults(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ------------------------------- actions ----------------------------- */
  const withPinRetry = async (action: string, run: (pin?: string) => Promise<void>) => {
    try {
      await run(undefined);
    } catch (e: any) {
      if (
        ['BELOW_FLOOR', 'BIG_DISCOUNT', 'OWNER_PIN_REQUIRED'].includes(e?.code) ||
        /owner PIN/i.test(e?.message ?? '')
      ) {
        setPinFor({ action, run });
      } else {
        toast(e?.message ?? 'Failed', 'err');
      }
    }
  };

  const doCheckout = async (pin?: string) => {
    setBusy(true);
    try {
      const body = {
        clientTxnId: crypto.randomUUID(),
        lines: cart.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          lineDiscount: l.lineDiscount && l.lineDiscount.val > 0 ? l.lineDiscount : null,
        })),
        orderDiscount:
          Number(orderDiscVal) > 0 ? { type: orderDiscType, val: Number(orderDiscVal) } : null,
        payment: { method, paidCents: paidCents },
        customerId: customer?.uuid ?? null,
        customerName: customer?.name ?? undefined,
        customerPhone: customer?.phone ?? undefined,
      };
      const r = await api<any>('/sales', {
        method: 'POST',
        body,
        headers: pin ? { 'x-owner-pin': pin } : undefined,
      });
      const sale = r.data;
      setReceiptSale(sale);
      setReceiptMode('checkout');
      setAutoPrintOnOpen(!!settings?.receiptPrinter?.autoPrint);
      loadParks();
      setPinFor(null);
      if (!r.duplicate) toast(`${sale.receiptNo} — ${fmtTaka(sale.totalCents)}`, 'ok');
    } catch (e: any) {
      if (
        ['BELOW_FLOOR', 'BIG_DISCOUNT', 'OWNER_PIN_REQUIRED'].includes(e?.code) ||
        /owner PIN/i.test(e?.message ?? '')
      ) {
        setPinFor({ action: 'Approve checkout', run: (p) => doCheckout(p) });
        toast(e?.message ?? 'Owner PIN required', 'err');
      } else {
        toast(e?.message ?? 'Checkout failed', 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  const closeReceipt = () => {
    const wasCheckout = receiptMode === 'checkout';
    setReceiptSale(null);
    setAutoPrintOnOpen(false);
    if (wasCheckout) clearSale(); // reprint must not wipe an in-progress cart
  };

  const hold = async () => {
    if (!cart.length) return;
    try {
      await api('/parks', {
        method: 'POST',
        body: {
          name: `Hold ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
          customerId: customer?.uuid ?? null,
          lines: cart.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            lineDiscountCents: discountAmount(l.lineDiscount, l.unitPrice * l.qty),
          })),
        },
      });
      toast('Cart parked — F6 or Recall brings it back', 'ok');
      clearSale();
      loadParks();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const recall = (p: Park) => {
    setCart(
      p.lines.map((l: any, i: number) => ({
        key: `${l.productId}-r${i}-${Date.now()}`,
        productId: l.productId,
        sku: l.product?.sku ?? '',
        name: l.product?.name ?? '(deleted product)',
        size: l.product?.size ?? '',
        qty: l.qty,
        unitPrice: l.unitPrice,
        floorPrice: 0,
        stock: l.product?.stock ?? 999,
        lineDiscount: l.lineDiscountCents > 0 ? { type: 'amt', val: l.lineDiscountCents } : null,
      }))
    );
    setShowRecall(false);
    toast(`Recalled "${p.name}"`, 'ok');
  };

  const createCustomer = async () => {
    if (!newCust?.name?.trim()) return toast('Customer name required', 'err');
    try {
      const r = await api<{ data: Customer }>('/customers', {
        method: 'POST',
        body: { name: newCust.name.trim(), phone: newCust.phone || '' },
      });
      setCustomer(r.data);
      setNewCust(null);
      setCustQuery('');
      toast('Customer added', 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  /* ------------------------------ history ------------------------------ */
  const loadHistory = () => {
    setHistLoading(true);
    api<{ data: Sale[] }>('/sales', {
      query: { from: histFrom, to: histTo, q: histQ, page: histPage, limit: 30 },
    })
      .then((r) => setHist(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setHistLoading(false));
  };

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, histFrom, histTo, histPage]);

  const doVoid = async () => {
    if (!voiding) return;
    try {
      await withPinRetry('Void sale', async (pin) => {
        await api(`/sales/${voiding.uuid}/void`, {
          method: 'POST',
          body: { reason: voidReason },
          headers: pin ? { 'x-owner-pin': pin } : undefined,
        });
        toast(`${voiding.receiptNo} voided — stock restored`, 'ok');
        setVoiding(null);
        setVoidReason('');
        setPinFor(null);
        loadHistory();
      });
    } catch {
      /* handled */
    }
  };

  /* ================================ UI ================================= */
  return (
    <>
      <div className="tabs">
        <button className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')}>
          🛒 Sell
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          🕘 History & reprint
        </button>
        <span style={{ marginLeft: 'auto', alignSelf: 'center' }} className="dim">
          F4 search · Enter add · F2 new sale · F6 hold
        </span>
      </div>

      {tab === 'sell' ? (
        <div className="grid" style={{ gridTemplateColumns: '1fr 340px', alignItems: 'start' }}>
          {/* ================= LEFT: search + cart ================= */}
          <div style={{ position: 'relative' }}>
            <div className="card" style={{ padding: 12 }}>
              <div className="row">
                <input
                  ref={searchRef}
                  className="input"
                  autoFocus
                  style={{ fontSize: 17, padding: '12px 14px' }}
                  placeholder="Scan barcode or type product name / SKU…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitSearch();
                    }
                  }}
                  onFocus={() => q && setShowResults(true)}
                />
                {searching && <Spinner />}
              </div>

              {showResults && (
                <div
                  className="tbl-wrap"
                  style={{
                    position: 'absolute',
                    left: 12,
                    right: 12,
                    top: 60,
                    zIndex: 30,
                    maxHeight: 340,
                    boxShadow: 'var(--shadow-lg)',
                  }}
                >
                  {results.length === 0 ? (
                    <div className="empty" style={{ padding: 20 }}>
                      <div style={{ fontWeight: 650 }}>No match for "{q}"</div>
                      <div className="dim">Check the barcode, or add the product first</div>
                    </div>
                  ) : (
                    <table className="tbl">
                      <tbody>
                        {results.map((p) => (
                          <tr key={p.uuid} style={{ cursor: 'pointer' }} onClick={() => addProduct(p)}>
                            <td>
                              <div style={{ fontWeight: 650 }}>
                                {p.name} {p.size && <span className="badge">{p.size}</span>}
                                {p.universal && <span className="badge info">universal</span>}
                              </div>
                              <div className="dim mono" style={{ fontSize: 11 }}>
                                {p.barcode} · {p.sku}
                                {p.variantGroup ? ` · ${p.variantGroup}` : ''}
                              </div>
                            </td>
                            <td className="num nowrap">
                              <b>{fmtTaka(p.sellPrice)}</b>
                              <div className={`dim ${p.stock <= (p.reorderLevel ?? 0) ? 'err-text' : ''}`}>
                                {p.stock} in stock
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* ---------------- cart ---------------- */}
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title">
                <h2>Cart {cart.length > 0 && <span className="badge info">{cart.length} lines</span>}</h2>
                {cart.length > 0 && (
                  <button className="btn sm" onClick={clearSale}>
                    Clear
                  </button>
                )}
              </div>

              {cart.length === 0 ? (
                <Empty icon="🛒" title="Empty cart" hint="Scan a barcode or search above" />
              ) : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th style={{ width: 118 }}>Qty</th>
                        <th style={{ width: 118 }}>Price</th>
                        <th style={{ width: 130 }}>Discount</th>
                        <th className="num" style={{ width: 110 }}>
                          Total
                        </th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cart.map((l) => {
                        const belowFloor = owner && l.floorPrice > 0 && l.unitPrice < l.floorPrice;
                        const base = l.unitPrice * l.qty;
                        const discAmt = discountAmount(l.lineDiscount, base);
                        return (
                          <tr key={l.key}>
                            <td>
                              <div style={{ fontWeight: 650 }}>
                                {l.name} {l.size && <span className="badge">{l.size}</span>}
                              </div>
                              <div className="dim mono" style={{ fontSize: 11 }}>
                                {l.sku}
                              </div>
                            </td>
                            <td>
                              <div className="row gap-sm">
                                <button className="btn sm" onClick={() => setLine(l.key, { qty: Math.max(1, l.qty - 1) })}>
                                  −
                                </button>
                                <input
                                  className="input center"
                                  style={{ padding: '5px 4px' }}
                                  type="number"
                                  value={l.qty}
                                  onChange={(e) =>
                                    setLine(l.key, { qty: Math.max(1, Number(e.target.value) || 1) })
                                  }
                                />
                                <button
                                  className="btn sm"
                                  onClick={() => {
                                    if (l.qty + 1 > l.stock) return toast(`Only ${l.stock} in stock`, 'err');
                                    setLine(l.key, { qty: l.qty + 1 });
                                  }}
                                >
                                  +
                                </button>
                              </div>
                            </td>
                            <td>
                              <input
                                className={`input ${belowFloor ? 'err' : ''}`}
                                style={{ padding: '6px 8px' }}
                                inputMode="decimal"
                                value={centsToTaka(l.unitPrice)}
                                onChange={(e) => setLine(l.key, { unitPrice: takaToCents(e.target.value) })}
                              />
                            </td>
                            <td>
                              <div className="row gap-sm">
                                <select
                                  className="input"
                                  style={{ padding: '6px 4px' }}
                                  value={l.lineDiscount?.type ?? 'amt'}
                                  onChange={(e) =>
                                    setLine(l.key, {
                                      lineDiscount: {
                                        type: e.target.value as 'pct' | 'amt',
                                        val: l.lineDiscount?.val ?? 0,
                                      },
                                    })
                                  }
                                >
                                  <option value="amt">৳</option>
                                  <option value="pct">%</option>
                                </select>
                                <input
                                  className="input"
                                  style={{ padding: '6px 6px' }}
                                  inputMode="decimal"
                                  value={l.lineDiscount?.val ? String(l.lineDiscount.val) : ''}
                                  placeholder="0"
                                  onChange={(e) =>
                                    setLine(l.key, {
                                      lineDiscount: {
                                        type: l.lineDiscount?.type ?? 'amt',
                                        val: Number(e.target.value) || 0,
                                      },
                                    })
                                  }
                                />
                              </div>
                            </td>
                            <td className="num" style={{ fontWeight: 700 }}>
                              {fmtTaka(base - discAmt)}
                            </td>
                            <td>
                              <button className="btn ghost sm" onClick={() => removeLine(l.key)}>
                                ✕
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {lowStockLine && (
                <p className="err-text" style={{ marginTop: 8 }}>
                  "{lowStockLine.name}" only has {lowStockLine.stock} in stock.
                </p>
              )}
            </div>
          </div>

          {/* ================= RIGHT: totals + pay ================= */}
          <div className="card" style={{ position: 'sticky', top: 0 }}>
            {/* customer */}
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Customer {method === 'due' && <span className="err-text">* required for credit</span>}</label>
              {customer ? (
                <div className="between" style={{ background: 'var(--brand-50)', borderRadius: 7, padding: '7px 10px' }}>
                  <div>
                    <b>{customer.name}</b>
                    <div className="dim" style={{ fontSize: 11 }}>
                      {customer.phone}
                      {(customer.dueBalance ?? 0) > 0 && (
                        <span className="err-text"> · due {fmtTaka(customer.dueBalance)}</span>
                      )}
                    </div>
                  </div>
                  <button className="btn ghost sm" onClick={() => setCustomer(null)}>
                    ✕
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    className="input"
                    placeholder="Search phone or name…"
                    value={custQuery}
                    onChange={(e) => setCustQuery(e.target.value)}
                  />
                  {custResults.length > 0 && (
                    <div className="tbl-wrap" style={{ maxHeight: 150, marginTop: 4 }}>
                      {custResults.map((c) => (
                        <div
                          key={c.uuid}
                          className="between"
                          style={{ padding: '7px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                          onClick={() => {
                            setCustomer(c);
                            setCustQuery('');
                            setCustResults([]);
                          }}
                        >
                          <span>
                            <b>{c.name}</b> <span className="dim">{c.phone}</span>
                          </span>
                          {(c.dueBalance ?? 0) > 0 && <span className="badge bad">due {fmtTaka(c.dueBalance)}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    className="btn ghost sm"
                    style={{ marginTop: 4 }}
                    onClick={() => setNewCust({ name: custQuery, phone: '' })}
                  >
                    + New customer {custQuery ? `“${custQuery}”` : ''}
                  </button>
                </div>
              )}
            </div>

            {/* totals */}
            <div className="between dim">
              <span>Subtotal</span>
              <span>{fmtTaka(subtotal)}</span>
            </div>
            {lineDiscTotal > 0 && (
              <div className="between dim">
                <span>Line discounts</span>
                <span className="err-text">−{fmtTaka(lineDiscTotal)}</span>
              </div>
            )}
            <div className="row" style={{ margin: '8px 0' }}>
              <span className="dim" style={{ flex: 1 }}>
                Order discount
              </span>
              <div className="pill-group">
                <button className={orderDiscType === 'amt' ? 'on' : ''} onClick={() => setOrderDiscType('amt')}>
                  ৳
                </button>
                <button className={orderDiscType === 'pct' ? 'on' : ''} onClick={() => setOrderDiscType('pct')}>
                  %
                </button>
              </div>
              <input
                className="input"
                style={{ width: 80, marginLeft: 6 }}
                inputMode="decimal"
                placeholder="0"
                value={orderDiscVal}
                onChange={(e) => setOrderDiscVal(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
            {orderDisc > 0 && (
              <div className="between dim">
                <span>Discount</span>
                <span className="err-text">−{fmtTaka(orderDisc)}</span>
              </div>
            )}

            <div
              className="between"
              style={{ borderTop: '2px solid var(--text)', paddingTop: 8, marginTop: 6, fontSize: 26, fontWeight: 800 }}
            >
              <span>TOTAL</span>
              <span>{fmtTaka(total)}</span>
            </div>

            {/* payment */}
            <div className="row wrap" style={{ margin: '12px 0 8px' }}>
              {(['cash', 'bkash', 'nagad', 'due'] as const).map((m) => (
                <button
                  key={m}
                  className={`btn sm ${method === m ? 'primary' : ''}`}
                  onClick={() => setMethod(m)}
                >
                  {m === 'due' ? 'Due (credit)' : m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>

            {method === 'cash' && (
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Cash received</label>
                <input
                  ref={paidRef}
                  className="input"
                  inputMode="decimal"
                  placeholder={centsToTaka(total) || '0'}
                  value={paidTaka}
                  onChange={(e) => setPaidTaka(e.target.value.replace(/[^\d.]/g, ''))}
                />
                <div className="row" style={{ marginTop: 4 }}>
                  {[total, Math.ceil(total / 500) * 500, 100000, 200000].map((v, i) => (
                    <button key={i} className="btn sm" onClick={() => setPaidTaka(String(v / 100))}>
                      ৳{v / 100}
                    </button>
                  ))}
                </div>
                <div className="between" style={{ marginTop: 6 }}>
                  <span className="dim">Change</span>
                  <b>{fmtTaka(change)}</b>
                </div>
              </div>
            )}
            {method === 'due' && (
              <div className="between" style={{ background: 'var(--red-50)', padding: '7px 10px', borderRadius: 7 }}>
                <span className="dim">Credit added to customer due</span>
                <b className="err-text">{fmtTaka(due)}</b>
              </div>
            )}

            {/* actions */}
            <button
              className="btn primary lg block"
              style={{ marginTop: 12, fontSize: 17, padding: '13px' }}
              disabled={busy || cart.length === 0}
              onClick={() => doCheckout()}
            >
              {busy ? <Spinner /> : `Charge ${fmtTaka(total)}`}
            </button>

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn block" onClick={hold} disabled={!cart.length}>
                ⏸ Hold (F6)
              </button>
              <button className="btn block" onClick={() => { setShowRecall(true); loadParks(); }}>
                ⏯ Recall {parks.length > 0 && <span className="badge info">{parks.length}</span>}
              </button>
            </div>

            <p className="hint" style={{ marginTop: 10 }}>
              Owner PIN is requested automatically when a price goes below floor or the discount
              exceeds 10%.
            </p>
          </div>
        </div>
      ) : (
        /* ================= HISTORY ================= */
        <div className="card">
          <div className="card-title">
            <div className="row wrap">
              <input className="input" style={{ width: 200 }} type="date" value={histFrom} onChange={(e) => { setHistFrom(e.target.value); setHistPage(1); }} />
              <input className="input" style={{ width: 200 }} type="date" value={histTo} onChange={(e) => { setHistTo(e.target.value); setHistPage(1); }} />
              <input className="input" style={{ width: 240 }} placeholder="Receipt #, customer, SKU…" value={histQ} onChange={(e) => setHistQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadHistory()} />
              <button className="btn sm" onClick={loadHistory}>Search</button>
            </div>
            <button className="btn sm" onClick={() => { setHistPage(1); loadHistory(); }}>
              ↻ Refresh
            </button>
          </div>

          {histLoading ? (
            <div className="center" style={{ padding: 30 }}><Spinner /></div>
          ) : hist.length === 0 ? (
            <Empty icon="🕘" title="No sales in this range" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>When</th>
                    <th>Customer</th>
                    <th className="num">Items</th>
                    <th className="num">Total</th>
                    {owner && <th className="num">Profit</th>}
                    <th>Payment</th>
                    <th>Status</th>
                    <th style={{ width: 160 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {hist.map((s) => (
                    <tr key={s.uuid}>
                      <td className="mono" style={{ fontWeight: 700 }}>{s.receiptNo}</td>
                      <td className="nowrap dim">
                        {new Date(s.createdAt).toLocaleString('en-GB', {
                          timeZone: 'Asia/Dhaka',
                          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td>{s.customerName}</td>
                      <td className="num">{s.lines?.length}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{fmtTaka(s.totalCents)}</td>
                      {owner && <td className="num dim">{fmtTaka(s.profitCents ?? 0)}</td>}
                      <td><Badge kind={s.payment?.method === 'due' ? 'bad' : 'ok'}>{s.payment?.method}</Badge></td>
                      <td>
                        {s.status === 'voided'
                          ? <Badge kind="bad">voided</Badge>
                          : <Badge kind="ok">completed</Badge>}
                      </td>
                      <td className="right nowrap">
                        <button className="btn sm" onClick={() => { setReceiptMode('reprint'); setAutoPrintOnOpen(false); setReceiptSale(s); }}>🖨 Reprint</button>{' '}
                        {s.status === 'completed' && (
                          <button className="btn sm" onClick={() => { setVoiding(s); setVoidReason(''); }}>
                            Void
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---------------- modals ---------------- */}
      {receiptSale && (
        <Receipt
          sale={receiptSale}
          settings={settings}
          onDone={closeReceipt}
          autoPrint={autoPrintOnOpen}
          mode={receiptMode}
        />
      )}

      {showRecall && (
        <Modal title="Recall a held cart" onClose={() => setShowRecall(false)}>
          {parks.length === 0 ? (
            <Empty icon="⏸" title="No held carts" hint="Hold the cart with F6 while serving another customer" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Name</th><th className="num">Lines</th><th className="num">Total</th><th></th></tr>
                </thead>
                <tbody>
                  {parks.map((p) => (
                    <tr key={p.uuid}>
                      <td style={{ fontWeight: 650 }}>{p.name}</td>
                      <td className="num">{p.lines.length}</td>
                      <td className="num">{fmtTaka(p.totalCents)}</td>
                      <td className="right nowrap">
                        <button className="btn sm primary" onClick={() => recall(p)}>Recall</button>{' '}
                        <button
                          className="btn sm"
                          onClick={async () => {
                            await api(`/parks/${p.uuid}/discard`, { method: 'POST' });
                            loadParks();
                          }}
                        >
                          Discard
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {newCust && (
        <Modal
          title="New customer"
          onClose={() => setNewCust(null)}
          footer={
            <>
              <button className="btn" onClick={() => setNewCust(null)}>Cancel</button>
              <button className="btn primary" onClick={createCustomer}>Add & select</button>
            </>
          }
        >
          <div className="grid">
            <div className="field">
              <label>Name *</label>
              <input className="input" autoFocus value={newCust.name} onChange={(e) => setNewCust({ ...newCust, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Phone</label>
              <input className="input" value={newCust.phone} onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })} />
            </div>
          </div>
        </Modal>
      )}

      {voiding && (
        <Modal
          title={`Void ${voiding.receiptNo}?`}
          onClose={() => setVoiding(null)}
          footer={
            <>
              <button className="btn" onClick={() => setVoiding(null)}>Cancel</button>
              <button className="btn danger" onClick={doVoid}>Void sale</button>
            </>
          }
        >
          <p className="muted">
            {fmtTaka(voiding.totalCents)} to <b>{voiding.customerName}</b>. Stock will be returned
            and the action written to the audit log permanently.
          </p>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Reason *</label>
            <input
              className="input"
              autoFocus
              placeholder="wrong item, customer changed mind…"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </div>
        </Modal>
      )}

      {pinFor && (
        <OwnerPinModal
          action={pinFor.action}
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
    </>
  );
}

/* ------------------------------ helpers ------------------------------ */
function discountAmount(
  d: { type: 'pct' | 'amt'; val: number } | null | undefined,
  base: number
): number {
  if (!d || !d.val) return 0;
  if (d.type === 'pct') return Math.round((base * Math.min(Math.max(d.val, 0), 100)) / 100);
  return Math.min(d.val, base);
}

export function OwnerPinModal({
  action,
  onSubmit,
  onClose,
}: {
  action: string;
  onSubmit: (pin: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (pin.length < 4) return;
    setBusy(true);
    try {
      await onSubmit(pin);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Owner approval"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || pin.length < 4}>
            {busy ? <Spinner /> : 'Approve'}
          </button>
        </>
      }
    >
      <p className="muted">{action} — the owner must approve with their PIN.</p>
      <input
        className="input center"
        style={{ fontSize: 22, letterSpacing: 8, marginTop: 14, textAlign: 'center' }}
        type="password"
        inputMode="numeric"
        maxLength={6}
        autoFocus
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="••••"
      />
      <p className="hint center" style={{ marginTop: 10 }}>
        The approval (and its outcome) is recorded in the audit log.
      </p>
    </Modal>
  );
}
