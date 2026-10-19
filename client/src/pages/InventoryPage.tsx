import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka } from '../api';
import { useToast, Spinner, Modal, Empty, Badge, fmtDateTime } from '../ui';
import { useAuth } from '../auth';

type Product = any;
type Move = any;
type Category = { uuid: string; name: string };

const MOVE_TYPES: Record<string, string> = {
  OPENING: 'info',
  SALE: 'bad',
  RETURN: 'ok',
  VOID_RETURN: 'ok',
  PURCHASE: 'ok',
  ADJUST: 'warn',
  EXCHANGE: 'info',
};

export function InventoryPage() {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('manageProducts');

  const [tab, setTab] = useState<'stock' | 'moves' | 'low'>('stock');
  const [summary, setSummary] = useState<any>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [reconcile, setReconcile] = useState<any>(null);
  const [reconBusy, setReconBusy] = useState(false);

  const catName = useMemo(() => Object.fromEntries(cats.map((c) => [c.uuid, c.name])), [cats]);

  const load = () => {
    setLoading(true);
    Promise.all([
      api<any>('/inventory/summary'),
      api<{ data: Product[] }>('/products', { query: { q, limit: 200, active: '' } }),
      api<{ data: Category[] }>('/categories').catch(() => ({ data: [] as Category[] })),
    ])
      .then(([s, p, c]) => {
        setSummary(s.data);
        setProducts(p.data);
        setCats(c.data);
      })
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);

  /* ------------------------------ low stock ------------------------------ */
  const [low, setLow] = useState<Product[]>([]);
  const [lowLoading, setLowLoading] = useState(false);
  const loadLow = () => {
    setLowLoading(true);
    api<{ data: Product[] }>('/inventory/low-stock')
      .then((r) => setLow(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLowLoading(false));
  };
  useEffect(() => {
    if (tab === 'low') loadLow();
  }, [tab]);

  /* ------------------------------ movements ------------------------------ */
  const [moves, setMoves] = useState<Move[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const [moveType, setMoveType] = useState('');
  const [moveFrom, setMoveFrom] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const loadMoves = () => {
    setMovesLoading(true);
    api<{ data: Move[] }>('/inventory/moves', {
      query: { type: moveType, from: moveFrom, to: moveTo, limit: 100 },
    })
      .then((r) => setMoves(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setMovesLoading(false));
  };
  useEffect(() => {
    if (tab === 'moves') loadMoves();
  }, [tab, moveType, moveFrom, moveTo]);

  const runReconcile = async () => {
    setReconBusy(true);
    try {
      const r = await api<any>('/inventory/reconcile');
      setReconcile(r.data);
      toast(r.data.ok ? 'Ledger matches cached stock everywhere' : `${r.data.mismatches.length} mismatches!`, r.data.ok ? 'ok' : 'err');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setReconBusy(false);
    }
  };

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Products</div>
          <div className="k-value">{summary?.products ?? '—'}</div>
          <div className="k-delta">{summary?.units ?? '—'} units on shelf</div>
        </div>
        <div className="card">
          <div className="k-label">Low stock</div>
          <div className="k-value" style={{ color: summary?.lowStock > 0 ? 'var(--amber)' : undefined }}>
            {summary?.lowStock ?? '—'}
          </div>
          <div className="k-delta">at or below reorder level</div>
        </div>
        {owner && (
          <div className="card">
            <div className="k-label">Stock value (at cost)</div>
            <div className="k-value">{summary ? fmtTaka(summary.stockValueCents) : '—'}</div>
            <div className="k-delta">owner only</div>
          </div>
        )}
        {owner && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <button className="btn" onClick={runReconcile} disabled={reconBusy}>
              {reconBusy ? <Spinner /> : '⚖ Reconcile ledger'}
            </button>
            {reconcile && (
              <div className={`k-delta ${reconcile.ok ? '' : 'err-text'}`} style={{ marginTop: 6 }}>
                {reconcile.ok
                  ? `✓ ${reconcile.checked} products verified`
                  : `✗ ${reconcile.mismatches.length} mismatch(es)`}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>
          📦 Stock
        </button>
        <button className={tab === 'moves' ? 'active' : ''} onClick={() => setTab('moves')}>
          ↕ Movements
        </button>
        <button className={tab === 'low' ? 'active' : ''} onClick={() => setTab('low')}>
          🔔 Low stock {low.length > 0 && <span className="badge bad">{low.length}</span>}
        </button>
      </div>

      {tab === 'stock' && (
        <div className="card">
          <div className="card-title">
            <input
              className="input"
              style={{ width: 280 }}
              placeholder="Search product, SKU…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="dim">{products.length} items</span>
          </div>
          {loading ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : products.length === 0 ? (
            <Empty icon="📦" title="No products" hint="Add products first" />
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: '62vh' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Category</th>
                    <th className="num">Stock</th>
                    <th className="num">Reorder at</th>
                    {owner && <th className="num">Value</th>}
                    <th style={{ width: 110 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => {
                    const level = p.reorderLevel || 3;
                    const lowFlag = p.stock <= level;
                    return (
                      <tr key={p.uuid}>
                        <td>
                          <div style={{ fontWeight: 650 }}>
                            {p.name} {p.size && <span className="badge">{p.size}</span>}
                          </div>
                          <div className="dim mono" style={{ fontSize: 11 }}>
                            {p.sku}
                          </div>
                        </td>
                        <td className="dim">{catName[p.categoryId] ?? '—'}</td>
                        <td className="num">
                          <b className={lowFlag ? 'err-text' : ''}>{p.stock}</b>
                          {lowFlag && <Badge kind="bad">low</Badge>}
                        </td>
                        <td className="num dim">{level}</td>
                        {owner && <td className="num dim">{fmtTaka(p.stock * (p.avgCost || 0))}</td>}
                        <td className="right">
                          {owner && (
                            <button className="btn sm" onClick={() => setAdjust(p)}>
                              Adjust
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'moves' && (
        <div className="card">
          <div className="card-title">
            <div className="row wrap">
              <select className="input" style={{ width: 165 }} value={moveType} onChange={(e) => setMoveType(e.target.value)}>
                <option value="">All movements</option>
                {Object.keys(MOVE_TYPES).map((t) => (
                  <option key={t} value={t}>
                    {t.replace('_', ' ')}
                  </option>
                ))}
              </select>
              <input className="input" style={{ width: 160 }} type="date" value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} />
              <input className="input" style={{ width: 160 }} type="date" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} />
            </div>
            <button className="btn sm" onClick={loadMoves}>
              ↻ Refresh
            </button>
          </div>
          {movesLoading ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : moves.length === 0 ? (
            <Empty icon="↕" title="No movements in this range" />
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: '62vh' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Product</th>
                    <th>Type</th>
                    <th className="num">Qty</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.uuid}>
                      <td className="dim nowrap">{fmtDateTime(m.createdAt)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {m.product?.name ?? '—'}
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {m.product?.sku}
                        </div>
                      </td>
                      <td>
                        <Badge kind={(MOVE_TYPES[m.type] as any) ?? 'info'}>{m.type.replace('_', ' ')}</Badge>
                      </td>
                      <td className="num" style={{ fontWeight: 700, color: m.qty >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {m.qty >= 0 ? `+${m.qty}` : m.qty}
                      </td>
                      <td className="dim">{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'low' && (
        <div className="card">
          <div className="card-title">
            <h2>Reorder reminders</h2>
            <div className="row">
              {owner && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      const r = await api<any>('/inventory/low-stock/scan', { method: 'POST' });
                      toast(`Queued ${r.data.queued} reminder(s)`, 'ok');
                    } catch (e: any) {
                      toast(e.message, 'err');
                    }
                  }}
                >
                  🔔 Queue reminders
                </button>
              )}
              <button className="btn sm" onClick={loadLow}>
                ↻
              </button>
            </div>
          </div>
          {lowLoading ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : low.length === 0 ? (
            <Empty icon="🎉" title="Everything is above its reorder level" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">In stock</th>
                    <th className="num">Level</th>
                    <th className="num">Short by</th>
                    {owner && <th className="num">Restock cost est.</th>}
                  </tr>
                </thead>
                <tbody>
                  {low.map((p) => (
                    <tr key={p.uuid}>
                      <td style={{ fontWeight: 650 }}>
                        {p.name}
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {p.sku}
                        </div>
                      </td>
                      <td className="num err-text" style={{ fontWeight: 700 }}>
                        {p.stock}
                      </td>
                      <td className="num dim">{p.level}</td>
                      <td className="num">{Math.max(0, p.level - p.stock)}</td>
                      {owner && (
                        <td className="num dim">
                          {fmtTaka(Math.max(0, p.level - p.stock) * (p.avgCost || 0))}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {adjust && (
        <AdjustModal
          product={adjust}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------- adjust modal ------------------------------ */
function AdjustModal({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const d = Number(delta) || 0;
  const projected = product.stock + d;

  const submit = async () => {
    if (!delta || d === 0) return toast('Enter a non-zero quantity', 'err');
    if (projected < 0) return toast('Stock cannot go negative', 'err');
    if (reason.trim().length < 3) return toast('A reason is required (it goes into the audit log)', 'err');

    setBusy(true);
    try {
      await api('/inventory/adjust', {
        method: 'POST',
        body: { productId: product.uuid, delta: d, reason: reason.trim() },
      });
      toast(`Stock ${product.stock} → ${projected}`, 'ok');
      onDone();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Adjust — ${product.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : 'Apply adjustment'}
          </button>
        </>
      }
    >
      <p className="muted">
        Current stock: <b>{product.stock}</b>. Use <b>−</b> for damage / theft / recount down, <b>+</b> for
        found items. The change and your reason are permanently audited.
      </p>
      <div className="grid" style={{ gridTemplateColumns: '160px 1fr', marginTop: 12 }}>
        <div className="field">
          <label>Change by</label>
          <input
            className="input"
            autoFocus
            inputMode="numeric"
            placeholder="+2 / -1"
            value={delta}
            onChange={(e) => setDelta(e.target.value.replace(/[^-\d]/g, ''))}
          />
        </div>
        <div className="field">
          <label>Result</label>
          <div
            className="input center"
            style={{ background: 'var(--surface-2)', fontWeight: 800, color: projected < 0 ? 'var(--red)' : undefined }}
          >
            {product.stock} → {projected}
          </div>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Reason *</label>
          <input
            className="input"
            placeholder="broken in shelf, yearly recount, entered twice…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
