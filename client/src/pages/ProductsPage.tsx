import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka, toCents } from '../api';
import { useToast, Spinner, Modal, Empty, Badge } from '../ui';
import { useAuth } from '../auth';

type Product = any;
type Category = { uuid: string; name: string };
type Brand = { uuid: string; name: string };
type Bike = { uuid: string; name: string; make: string };

export function ProductsPage() {
  const toast = useToast();
  const { can } = useAuth();

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [inStock, setInStock] = useState(false);
  const [page, setPage] = useState(1);

  const [cats, setCats] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [bikes, setBikes] = useState<Bike[]>([]);

  const [form, setForm] = useState<{ open: boolean; value: Product | null }>({ open: false, value: null });
  const [deleting, setDeleting] = useState<Product | null>(null);

  const owner = can('viewCost');
  const limit = 50;

  // reference data
  useEffect(() => {
    api<{ data: Category[] }>('/categories').then((r) => setCats(r.data)).catch(() => {});
    api<{ data: Brand[] }>('/brands').then((r) => setBrands(r.data)).catch(() => {});
    api<{ data: Bike[] }>('/bike-models').then((r) => setBikes(r.data)).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    api<{ data: Product[]; meta: { total: number } }>('/products', {
      query: { q, categoryId, brandId, inStock: inStock ? '1' : '', page, limit },
    })
      .then((r) => {
        setItems(r.data);
        setTotal(r.meta.total);
      })
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  // debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      load();
    }, 250);
    return () => clearTimeout(t);
  }, [q, categoryId, brandId, inStock]);

  useEffect(() => {
    load();
  }, [page]);

  const catName = useMemo(() => Object.fromEntries(cats.map((c) => [c.uuid, c.name])), [cats]);
  const brandName = useMemo(() => Object.fromEntries(brands.map((b) => [b.uuid, b.name])), [brands]);

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <div className="card">
        <div className="card-title wrap row">
          <div className="row wrap" style={{ flex: 1 }}>
            <input
              className="input"
              style={{ width: 280 }}
              placeholder="Search name, SKU, barcode, model…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="input" style={{ width: 170 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {cats.map((c) => (
                <option key={c.uuid} value={c.uuid}>
                  {c.name}
                </option>
              ))}
            </select>
            <select className="input" style={{ width: 150 }} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.uuid} value={b.uuid}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className="row gap-sm dim" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} />
              In stock only
            </label>
          </div>
          {can('manageProducts') && (
            <button className="btn primary" onClick={() => setForm({ open: true, value: null })}>
              + New product
            </button>
          )}
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            icon="📦"
            title={q ? 'Nothing matches that search' : 'No products yet'}
            hint={q ? 'Try a shorter keyword or the barcode' : 'Add your first product — it appears in every dropdown instantly'}
          />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU / Barcode</th>
                  <th>Category</th>
                  <th className="num">Stock</th>
                  {owner && <th className="num">Purchase</th>}
                  {owner && <th className="num">Margin price</th>}
                  <th className="num">Selling</th>
                  {owner && <th className="num">MRP</th>}
                  {owner && <th className="num">Margin</th>}
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const marginPct =
                    owner && p.avgCost > 0
                      ? Math.round(((p.sellPrice - p.avgCost) / p.avgCost) * 10000) / 100
                      : null;
                  const target =
                    p.defaultMarginPct != null
                      ? Math.round(p.avgCost * (1 + p.defaultMarginPct / 100))
                      : null;
                  return (
                    <tr key={p.uuid}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {p.name}{' '}
                          {p.size && <span className="badge">{p.size}</span>}{' '}
                          {p.universal && <span className="badge info">universal</span>}
                          {!p.universal && p.bikeModelIds?.length > 0 && (
                            <span className="badge">{p.bikeModelIds.length} bikes</span>
                          )}
                        </div>
                        {p.variantGroup && <div className="dim">{p.variantGroup}</div>}
                      </td>
                      <td className="mono dim" style={{ fontSize: 12 }}>
                        {p.sku}
                        <br />
                        {p.barcode}
                      </td>
                      <td className="dim">{catName[p.categoryId] ?? '—'}</td>
                      <td className="num">
                        <span className={`badge ${p.stock <= (p.reorderLevel || 0) ? 'warn' : 'ok'}`}>
                          {p.stock}
                        </span>
                      </td>
                      {owner && <td className="num dim">{fmtTaka(p.avgCost)}</td>}
                      {owner && <td className="num dim">{target != null ? fmtTaka(target) : '—'}</td>}
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtTaka(p.sellPrice)}
                      </td>
                      {owner && <td className="num dim">{p.mrp != null ? fmtTaka(p.mrp) : '—'}</td>}
                      {owner && (
                        <td className="num">
                          {marginPct != null ? (
                            <span className={`badge ${marginPct < 0 ? 'bad' : marginPct < 10 ? 'warn' : 'ok'}`}>
                              {marginPct > 0 ? '+' : ''}
                              {marginPct}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                      <td className="right nowrap">
                        {can('manageProducts') && (
                          <>
                            <button className="btn sm" onClick={() => setForm({ open: true, value: p })}>
                              Edit
                            </button>{' '}
                            <button className="btn sm" onClick={() => setDeleting(p)}>
                              ✕
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > limit && (
          <div className="between" style={{ marginTop: 12 }}>
            <span className="dim">
              {page}–{Math.min(page * limit, total)} of {total}
            </span>
            <div className="row">
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ← Prev
              </button>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {form.open && (
        <ProductForm
          value={form.value}
          cats={cats}
          brands={brands}
          bikes={bikes}
          onClose={() => setForm({ open: false, value: null })}
          onSaved={() => {
            setForm({ open: false, value: null });
            load();
          }}
        />
      )}

      {deleting && (
        <Modal
          title="Delete product"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  try {
                    await api(`/products/${deleting.uuid}`, { method: 'DELETE' });
                    toast('Product deleted', 'ok');
                    setDeleting(null);
                    load();
                  } catch (e: any) {
                    toast(e.message, 'err');
                  }
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>
            Delete <b>{deleting.name}</b>?
            {deleting.stock !== 0 && (
              <span className="err-text">
                {' '}
                — stock on hand is {deleting.stock}; it must be adjusted to zero first.
              </span>
            )}
          </p>
        </Modal>
      )}
    </>
  );
}

/* ===================================================================== *
 * Product form — basics, fitment, and the owner-only four-price block.
 * ===================================================================== */
function ProductForm({
  value,
  cats,
  brands,
  bikes,
  onClose,
  onSaved,
}: {
  value: Product | null;
  cats: Category[];
  brands: Brand[];
  bikes: Bike[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const owner = can('viewCost');
  const isEdit = !!value;

  const t = (cents: number | null | undefined) =>
    cents == null ? '' : String(Math.round(cents / 100));

  const [f, setF] = useState({
    name: value?.name ?? '',
    sku: value?.sku ?? '',
    barcodeType: value?.barcodeType ?? 'CODE128',
    barcode: value?.barcode ?? '',
    categoryId: value?.categoryId ?? cats[0]?.uuid ?? '',
    brandId: value?.brandId ?? '',
    productModel: value?.productModel ?? '',
    size: value?.size ?? '',
    color: value?.color ?? '',
    variantGroup: value?.variantGroup ?? '',
    universal: value?.universal ?? false,
    bikeModelIds: (value?.bikeModelIds ?? []) as string[],
    avgCost: t(value?.avgCost),
    floorPrice: t(value?.floorPrice),
    sellPrice: t(value?.sellPrice),
    mrp: t(value?.mrp),
    defaultMarginPct: value?.defaultMarginPct != null ? String(value.defaultMarginPct) : '',
    warrantyDays: value?.warrantyDays ?? 0,
    reorderLevel: value?.reorderLevel ?? 3,
    active: value?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [showFitment, setShowFitment] = useState(!(value?.universal ?? false));

  const set = (k: string, v: unknown) => setF((prev) => ({ ...prev, [k]: v }));

  const costC = toCents(f.avgCost);
  const sellC = toCents(f.sellPrice);
  const floorC = toCents(f.floorPrice);
  const mrpC = f.mrp === '' ? null : toCents(f.mrp);

  const marginPctSetting = 25; // live settings value is cosmetic here; server computes target price too
  const effectivePct = f.defaultMarginPct === '' ? marginPctSetting : Number(f.defaultMarginPct);
  const targetC = Math.round(costC * (1 + effectivePct / 100));
  const marginPctActual = costC > 0 ? Math.round(((sellC - costC) / costC) * 10000) / 100 : null;

  const save = async () => {
    if (!f.name.trim()) return toast('Product name is required', 'err');
    if (!f.categoryId) return toast('Pick a category', 'err');
    if (sellC <= 0 && owner) return toast('Selling price is required', 'err');
    if (owner && floorC > 0 && sellC > 0 && floorC > sellC) {
      return toast('Floor price cannot be higher than the selling price', 'err');
    }

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        barcodeType: f.barcodeType,
        barcode: f.barcode || undefined,
        categoryId: f.categoryId,
        brandId: f.brandId || null,
        productModel: f.productModel,
        size: f.size,
        color: f.color,
        variantGroup: f.variantGroup,
        universal: f.universal,
        bikeModelIds: f.bikeModelIds,
        warrantyDays: Number(f.warrantyDays) || 0,
        reorderLevel: Number(f.reorderLevel) || 0,
        active: f.active,
        sellPrice: sellC,
      };
      if (owner) {
        body.avgCost = costC;
        body.floorPrice = floorC;
        body.mrp = mrpC;
        body.defaultMarginPct = f.defaultMarginPct === '' ? null : Number(f.defaultMarginPct);
      }
      if (isEdit) {
        await api(`/products/${value.uuid}`, { method: 'PATCH', body });
        toast('Product updated', 'ok');
      } else {
        await api('/products', { method: 'POST', body });
        toast('Product created — it is already available in every dropdown', 'ok');
      }
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
      if (e?.details?.field === 'barcode') set('barcode', '');
    } finally {
      setBusy(false);
    }
  };

  const toggleBike = (uuid: string) =>
    set('bikeModelIds', f.bikeModelIds.includes(uuid) ? f.bikeModelIds.filter((b) => b !== uuid) : [...f.bikeModelIds, uuid]);

  return (
    <Modal
      title={isEdit ? `Edit — ${value.name}` : 'New product'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : isEdit ? 'Save changes' : 'Create product'}
          </button>
        </>
      }
    >
      <div className="grid">
        {/* ---------- basics ---------- */}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Product name *</label>
            <input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Studds Thunder Full Face Helmet" />
          </div>

          <div className="field">
            <label>Category *</label>
            <select className="input" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {cats.map((c) => (
                <option key={c.uuid} value={c.uuid}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Brand</label>
            <select className="input" value={f.brandId} onChange={(e) => set('brandId', e.target.value)}>
              <option value="">— none —</option>
              {brands.map((b) => (
                <option key={b.uuid} value={b.uuid}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Size / Variant of</label>
            <input className="input" value={f.size} onChange={(e) => set('size', e.target.value)} placeholder="M, L, XL, 1L…" />
            <span className="hint">Sizes are separate products (own SKU + barcode), grouped automatically.</span>
          </div>

          <div className="field">
            <label>Variant group</label>
            <input className="input" value={f.variantGroup} onChange={(e) => set('variantGroup', e.target.value)} placeholder="product line shown as a strip in POS" />
          </div>

          <div className="field">
            <label>Model</label>
            <input className="input" value={f.productModel} onChange={(e) => set('productModel', e.target.value)} placeholder="Pulsar 150, H4, RTR 160…" />
          </div>

          <div className="field">
            <label>Colour</label>
            <input className="input" value={f.color} onChange={(e) => set('color', e.target.value)} />
          </div>

          <div className="field">
            <label>Warranty (days)</label>
            <input className="input" type="number" value={f.warrantyDays} onChange={(e) => set('warrantyDays', e.target.value)} />
          </div>

          <div className="field">
            <label>Reorder alert level</label>
            <input className="input" type="number" value={f.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} />
          </div>
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)' }} />

        {/* ---------- barcode ---------- */}
        <div className="grid" style={{ gridTemplateColumns: '140px 1fr 1fr' }}>
          <div className="field">
            <label>Symbology</label>
            <select className="input" value={f.barcodeType} onChange={(e) => set('barcodeType', e.target.value)}>
              <option value="CODE128">Code128</option>
              <option value="EAN13">EAN-13</option>
            </select>
          </div>
          <div className="field">
            <label>Barcode</label>
            <input
              className="input mono"
              value={f.barcode}
              onChange={(e) => set('barcode', e.target.value)}
              placeholder={f.barcodeType === 'EAN13' ? '12 or 13 digits (check digit auto)' : 'auto-generated from SKU if blank'}
            />
          </div>
          <div className="field">
            <label>SKU {isEdit && <span className="hint">(immutable)</span>}</label>
            <input className="input mono" value={f.sku} readOnly={isEdit} placeholder="auto-generated" onChange={(e) => set('sku', e.target.value)} />
          </div>
        </div>

        {/* ---------- fitment ---------- */}
        <div>
          <div className="between">
            <h3>Fits which bikes?</h3>
            <label className="row gap-sm dim" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={f.universal}
                onChange={(e) => {
                  set('universal', e.target.checked);
                  setShowFitment(!e.target.checked);
                }}
              />
              Universal (fits everything)
            </label>
          </div>
          {showFitment && (
            <div className="row wrap" style={{ marginTop: 8, maxHeight: 150, overflowY: 'auto', gap: 6 }}>
              {bikes.map((b) => (
                <button
                  key={b.uuid}
                  className={`badge ${f.bikeModelIds.includes(b.uuid) ? 'info' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => toggleBike(b.uuid)}
                >
                  {f.bikeModelIds.includes(b.uuid) ? '✓ ' : ''}
                  {b.name}
                </button>
              ))}
              {bikes.length === 0 && <span className="dim">No bike models yet — add them under Inventory.</span>}
            </div>
          )}
        </div>

        {/* ---------- four prices ---------- */}
        <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="card-title">
            <h3>💰 Pricing</h3>
            {!owner && <Badge kind="info">owner sees all four</Badge>}
          </div>

          {owner ? (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <div className="field">
                  <label>① Purchase price (avg)</label>
                  <input className="input" inputMode="decimal" value={f.avgCost} onChange={(e) => set('avgCost', e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label>② Margin price ({effectivePct}%)</label>
                  <input className="input" readOnly value={costC > 0 ? (targetC / 100).toFixed(2) : ''} placeholder="auto" />
                  <span className="hint">target — computed</span>
                </div>
                <div className="field">
                  <label>③ Selling price *</label>
                  <input className="input" inputMode="decimal" value={f.sellPrice} onChange={(e) => set('sellPrice', e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label>④ MRP (printed)</label>
                  <input className="input" inputMode="decimal" value={f.mrp} onChange={(e) => set('mrp', e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label>Floor price (bargain floor)</label>
                  <input className="input" inputMode="decimal" value={f.floorPrice} onChange={(e) => set('floorPrice', e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label>Override margin %</label>
                  <input className="input" type="number" value={f.defaultMarginPct} onChange={(e) => set('defaultMarginPct', e.target.value)} placeholder="shop default" />
                </div>
              </div>

              <div className="row wrap mt" style={{ gap: 14 }}>
                <span className="dim">
                  Profit / item:{' '}
                  <b style={{ color: sellC - costC >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {fmtTaka(sellC - costC)}
                  </b>
                </span>
                <span className="dim">
                  Margin:{' '}
                  <b>{marginPctActual != null ? `${marginPctActual}%` : '—'}</b>
                </span>
                <span className="dim">
                  vs floor: <b>{fmtTaka(sellC - floorC)}</b>
                </span>
              </div>
              <p className="hint mt">
                Shown to owners only — cashiers never receive these numbers (stripped server-side).
              </p>
            </>
          ) : (
            <div className="row">
              <div className="field" style={{ maxWidth: 220 }}>
                <label>Selling price *</label>
                <input className="input" inputMode="decimal" value={f.sellPrice} onChange={(e) => set('sellPrice', e.target.value)} placeholder="0" />
              </div>
              <span className="dim" style={{ marginLeft: 10 }}>
                Cost, floor and margin data are hidden for your role.
              </span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
