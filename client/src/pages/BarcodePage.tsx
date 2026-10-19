import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, fmtTaka } from '../api';
import { useToast, Spinner, Empty } from '../ui';
import { useAuth } from '../auth';

type Product = any;
type Category = { uuid: string; name: string };
type Settings = any;

/** Template geometry (mm) — drives both preview and @page print rules. */
const TEMPLATES: Record<string, { labelW: number; labelH: number; cols: number; page: string; gap: number }> = {
  '38x25': { labelW: 38, labelH: 25, cols: 1, page: '38mm auto', gap: 0 },
  '50x30': { labelW: 50, labelH: 30, cols: 1, page: '50mm auto', gap: 0 },
  'a4-3x8': { labelW: 70, labelH: 27, cols: 3, page: 'A4', gap: 1.4 },
  'a4-3x7': { labelW: 70, labelH: 31, cols: 3, page: 'A4', gap: 1.4 },
  'a4-5x3': { labelW: 38, labelH: 50, cols: 5, page: 'A4', gap: 1.6 },
};

export function BarcodePage() {
  const toast = useToast();
  const { user } = useAuth();

  const [items, setItems] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [template, setTemplate] = useState('38x25');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [showPrice, setShowPrice] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [barcodes, setBarcodes] = useState<Record<string, string>>({}); // productId -> objectURL
  const [printing, setPrinting] = useState(false);

  const catName = useMemo(() => Object.fromEntries(cats.map((c) => [c.uuid, c.name])), [cats]);

  /* ---------------- reference data ---------------- */
  useEffect(() => {
    api<{ data: Category[] }>('/categories').then((r) => setCats(r.data)).catch(() => {});
    api<{ data: Settings }>('/settings')
      .then((r) => {
        setSettings(r.data);
        const t = r.data?.labelPrinter?.template;
        if (t && TEMPLATES[t]) setTemplate(t);
        if (r.data?.labelPrinter && 'showMrp' in r.data.labelPrinter) setShowPrice(!!r.data.labelPrinter.showMrp);
      })
      .catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    api<{ data: Product[] }>('/products', { query: { q, categoryId, limit: 200 } })
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q, categoryId]);

  /* ---------------- barcode images (auth header required => blob) ---------------- */
  const urlCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const wanted = [...selected];
    (async () => {
      for (const id of wanted) {
        if (barcodes[id] || urlCache.current.has(id)) continue;
        try {
          const res = await fetch(`/api/products/${id}/barcode.png?scale=3`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          });
          if (!res.ok) continue;
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          urlCache.current.set(id, url);
          if (alive) setBarcodes((prev) => ({ ...prev, [id]: url }));
        } catch {
          /* skip */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected]);

  useEffect(() => () => urlCache.current.forEach((u) => URL.revokeObjectURL(u)), []);

  /* ---------------- selection helpers ---------------- */
  const rowsToPrint: { product: Product; qty: number }[] = useMemo(
    () =>
      items
        .filter((p) => selected.has(p.uuid))
        .flatMap((p) => {
          const qty = Math.max(1, Number(quantities[p.uuid]) || 1);
          return Array.from({ length: Math.min(qty, 100) }, () => ({ product: p, qty: 1 }));
        }),
    [items, selected, quantities]
  );

  const toggle = (uuid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });

  const selectAllVisible = () =>
    setSelected((prev) => {
      const all = items.every((p) => prev.has(p.uuid));
      const next = new Set(prev);
      for (const p of items) (all ? next.delete(p.uuid) : next.add(p.uuid));
      return next;
    });

  /* ---------------- print ---------------- */
  const geo = TEMPLATES[template] ?? TEMPLATES['38x25'];

  const doPrint = () => {
    if (rowsToPrint.length === 0) return toast('Select at least one product', 'err');
    setPrinting(true);
    // let the last barcode blobs resolve, then hand off to the browser dialog
    setTimeout(() => {
      setPrinting(false);
      window.print();
    }, 600);
  };

  return (
    <>
      {/* dynamic @page rules — keep preview and paper identical */}
      <style>{`
        @page label { size: ${geo.page}; margin: ${geo.page === 'A4' ? '8mm' : '0'}; }
        @media print {
          .no-print { display: none !important; }
          .label-grid { gap: ${geo.gap}mm; }
        }
      `}</style>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(320px, 40%) 1fr', alignItems: 'start' }}>
        {/* ------------------ picker ------------------ */}
        <div className="card no-print" style={{ alignSelf: 'stretch' }}>
          <div className="card-title">
            <h2>1 · Choose products</h2>
            <span className="badge info">{selected.size} selected</span>
          </div>

          <div className="row wrap" style={{ marginBottom: 10 }}>
            <input
              className="input"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ flex: 1, minWidth: 130 }}
            />
            <select className="input" style={{ width: 150 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {cats.map((c) => (
                <option key={c.uuid} value={c.uuid}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn sm" onClick={selectAllVisible}>
              {items.every((p) => selected.has(p.uuid)) && items.length > 0 ? 'Deselect all' : 'Select all'}
            </button>
            <button className="btn sm" onClick={() => setSelected(new Set())}>
              Clear
            </button>
            <span className="dim" style={{ marginLeft: 'auto' }}>
              {rowsToPrint.length} label{rowsToPrint.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="tbl-wrap" style={{ maxHeight: '55vh' }}>
            {loading ? (
              <div className="center" style={{ padding: 26 }}>
                <Spinner />
              </div>
            ) : items.length === 0 ? (
              <Empty icon="🏷" title="No products match" />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}></th>
                    <th>Product</th>
                    <th style={{ width: 74 }}>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.uuid} onClick={() => toggle(p.uuid)} style={{ cursor: 'pointer' }}>
                      <td>
                        <input type="checkbox" readOnly checked={selected.has(p.uuid)} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {p.name} {p.size && <span className="badge">{p.size}</span>}
                        </div>
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {p.barcode} · {catName[p.categoryId] ?? ''}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          style={{ padding: '5px 6px' }}
                          value={quantities[p.uuid] ?? 1}
                          onChange={(e) =>
                            setQuantities((prev) => ({ ...prev, [p.uuid]: Math.max(1, Number(e.target.value) || 1) }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ------------------ preview ------------------ */}
        <div className="card">
          <div className="card-title no-print">
            <h2>2 · Preview & print</h2>
            <div className="row">
              <select className="input" style={{ width: 165 }} value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="38x25">38 × 25 mm (roll)</option>
                <option value="50x30">50 × 30 mm (roll)</option>
                <option value="a4-3x8">A4 sheet · 3 × 8</option>
                <option value="a4-3x7">A4 sheet · 3 × 7</option>
                <option value="a4-5x3">A4 sheet · 5 × 3</option>
              </select>
              <label className="row gap-sm dim" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
                show price
              </label>
              <button className="btn primary" onClick={doPrint} disabled={printing || rowsToPrint.length === 0}>
                {printing ? <Spinner /> : `🖨 Print ${rowsToPrint.length} label${rowsToPrint.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>

          {rowsToPrint.length === 0 ? (
            <Empty icon="🖼" title="Nothing selected" hint="Pick products on the left — labels appear here" />
          ) : (
            <div className="scroll-x">
              <div
                className="label-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${geo.cols}, ${geo.labelW}mm)`,
                  gap: `${geo.gap}mm`,
                  justifyContent: 'center',
                  background: '#fff',
                  padding: geo.page === 'A4' ? 0 : '4mm',
                }}
              >
                {rowsToPrint.map(({ product }, i) => (
                  <div
                    key={`${product.uuid}-${i}`}
                    style={{
                      width: `${geo.labelW}mm`,
                      height: `${geo.labelH}mm`,
                      border: '1px dashed #bbb',
                      borderRadius: 1.5,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '1mm',
                      background: '#fff',
                      color: '#000',
                    }}
                  >
                    <div style={{ fontSize: 5.2, letterSpacing: 0.3, fontWeight: 700, textTransform: 'uppercase' }}>
                      {settings?.shopName ?? 'UTSHO GEAR'}
                    </div>
                    <div
                      style={{
                        fontSize: 5.4,
                        fontWeight: 700,
                        textAlign: 'center',
                        lineHeight: 1.1,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {product.name}
                      {product.size ? ` (${product.size})` : ''}
                    </div>

                    {barcodes[product.uuid] ? (
                      <img
                        src={barcodes[product.uuid]}
                        alt=""
                        style={{ height: geo.labelH <= 30 ? '11mm' : '13mm', objectFit: 'contain' }}
                      />
                    ) : (
                      <div style={{ fontSize: 4.6, color: '#777' }}>loading barcode…</div>
                    )}

                    {showPrice && (
                      <div style={{ fontSize: 5.4, fontWeight: 800, marginTop: '0.5mm' }}>
                        {fmtTaka(product.mrp ?? product.sellPrice, true)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="hint no-print" style={{ marginTop: 10 }}>
            Print dialog: pick the label printer, set margins to <b>None</b> and enable
            <b> Background graphics</b> for exact sizing. Calibration offsets (mm) live in
            Settings → Printing and apply to every job.
          </p>
        </div>
      </div>
    </>
  );
}
