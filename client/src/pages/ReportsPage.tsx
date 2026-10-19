import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtTaka } from '../api';
import { useToast, Spinner, Empty } from '../ui';
import { useAuth } from '../auth';

const bizToday = () => {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Dhaka' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
const shiftDay = (d: string, delta: number) => {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
};
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

type Period = 'today' | 'yesterday' | 'week' | 'month' | '6m' | 'year' | 'custom';

function periodRange(p: Period, custom: { from: string; to: string }) {
  const t = bizToday();
  switch (p) {
    case 'today':
      return { from: t, to: t };
    case 'yesterday':
      return { from: shiftDay(t, -1), to: shiftDay(t, -1) };
    case 'week':
      return { from: shiftDay(t, -6), to: t };
    case 'month':
      return { from: monthStart(t), to: t };
    case '6m': {
      const d = new Date(`${t}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 5, 1);
      return { from: d.toISOString().slice(0, 10), to: t };
    }
    case 'year':
      return { from: `${t.slice(0, 4)}-01-01`, to: t };
    default:
      return custom;
  }
}

export function ReportsPage() {
  const toast = useToast();
  const [period, setPeriod] = useState<Period>('week');
  const [custom, setCustom] = useState({ from: bizToday(), to: bizToday() });

  const [profit, setProfit] = useState<any>(null);
  const [top, setTop] = useState<any[]>([]);
  const [byCat, setByCat] = useState<any[]>([]);
  const [cashbook, setCashbook] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const { from, to } = useMemo(() => periodRange(period, custom), [period, custom]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<any>('/reports/profit', { query: { from, to } }),
      api<{ data: any[] }>('/reports/top-products', { query: { from, to, limit: 10 } }),
      api<{ data: any[] }>('/reports/expenses-by-category', { query: { from, to } }),
      api<any>('/reports/cashbook', { query: { from, to } }),
    ])
      .then(([p, t, c, cb]) => {
        setProfit(p.data);
        setTop(t.data);
        setByCat(c.data);
        setCashbook(cb.data);
      })
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  }, [from, to]);

  /* fill missing days so the chart shows real gaps as zeroes */
  const series = useMemo(() => {
    if (!profit) return [];
    const map = new Map(profit.series.map((d: any) => [d.date, d]));
    const out: any[] = [];
    let cursor = from;
    let guard = 0;
    while (cursor <= to && guard++ < 800) {
      out.push(
        map.get(cursor) ?? {
          date: cursor,
          count: 0,
          totalCents: 0,
          cogsCents: 0,
          profitCents: 0,
          expensesCents: 0,
        }
      );
      cursor = shiftDay(cursor, 1);
    }
    return out;
  }, [profit, from, to]);

  const max = Math.max(1, ...series.map((d) => d.totalCents));
  const totals = profit?.totals;
  const avgBasket = totals?.count ? Math.round(totals.sales / totals.count) : 0;
  const marginPct = totals?.sales ? Math.round((totals.profit / totals.sales) * 1000) / 10 : 0;

  const exportCsv = () => {
    const header = 'date,receipts,sales_tk,cost_tk,gross_profit_tk,expenses_tk,net_tk';
    const rows = series.map((d) =>
      [d.date, d.count, d.totalCents / 100, d.cogsCents / 100, d.profitCents / 100, d.expensesCents / 100, (d.profitCents - d.expensesCents) / 100].join(',')
    );
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `utsho-report-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {(
          [
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['week', 'Last 7 days'],
            ['month', 'This month'],
            ['6m', '6 months'],
            ['year', 'This year'],
            ['custom', 'Custom'],
          ] as [Period, string][]
        ).map(([p, label]) => (
          <button key={p} className={`btn sm ${period === p ? 'primary' : ''}`} onClick={() => setPeriod(p)}>
            {label}
          </button>
        ))}
        {period === 'custom' && (
          <span className="row gap-sm">
            <input className="input" style={{ width: 155 }} type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <span className="dim">→</span>
            <input className="input" style={{ width: 155 }} type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </span>
        )}
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={exportCsv} disabled={!series.length}>
          ⬇ CSV
        </button>
      </div>

      {loading || !totals ? (
        <div className="center" style={{ padding: 40 }}>
          <Spinner />
        </div>
      ) : (
        <>
          <div className="kpi">
            <div className="card">
              <div className="k-label">Sales</div>
              <div className="k-value">{fmtTaka(totals.sales)}</div>
              <div className="k-delta">{totals.count} receipts · avg {fmtTaka(avgBasket)}</div>
            </div>
            <div className="card">
              <div className="k-label">Cost of goods</div>
              <div className="k-value">{fmtTaka(totals.cogs)}</div>
              <div className="k-delta">gross profit {fmtTaka(totals.sales - totals.cogs)}</div>
            </div>
            <div className="card">
              <div className="k-label">Expenses</div>
              <div className="k-value">{fmtTaka(totals.expenses)}</div>
              <div className="k-delta">daily costing total</div>
            </div>
            <div className="card">
              <div className="k-label">NET PROFIT</div>
              <div className="k-value" style={{ color: totals.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {fmtTaka(totals.profit)}
              </div>
              <div className="k-delta">margin {marginPct}% on sales</div>
            </div>
          </div>

          {/* chart */}
          <div className="card mt">
            <div className="card-title">
              <h2>Sales per day</h2>
              <span className="row gap-sm dim" style={{ fontSize: 12 }}>
                <span className="row gap-sm"><i style={{ width: 10, height: 10, background: 'var(--green)', borderRadius: 2, display: 'inline-block' }} /> profit</span>
                <span className="row gap-sm"><i style={{ width: 10, height: 10, background: 'var(--border-strong, #cbd5e1)', borderRadius: 2, display: 'inline-block' }} /> cost</span>
                <span className="row gap-sm"><i style={{ width: 10, height: 10, background: 'var(--amber)', borderRadius: 2, display: 'inline-block' }} /> expenses</span>
              </span>
            </div>
            {series.every((d) => d.totalCents === 0) ? (
              <Empty icon="📈" title="No sales in this range" />
            ) : (
              <div className="scroll-x">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: series.length > 90 ? 1 : 4, height: 190, padding: '8px 4px 0' }}>
                  {series.map((d) => {
                    const h = (d.totalCents / max) * 160;
                    const costH = d.totalCents ? (d.cogsCents / d.totalCents) * h : 0;
                    const expH = Math.min(12, (d.expensesCents / max) * 160);
                    return (
                      <div
                        key={d.date}
                        title={`${d.date}\nsales ${fmtTaka(d.totalCents)}\ncost ${fmtTaka(d.cogsCents)}\nprofit ${fmtTaka(d.profitCents)}\nexpenses ${fmtTaka(d.expensesCents)}`}
                        style={{ width: series.length > 90 ? 3 : 14, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', flex: series.length > 90 ? 1 : undefined }}
                      >
                        {expH > 0 && <div style={{ height: expH, background: 'var(--amber)', borderRadius: 2 }} />}
                        <div style={{ height: h - expH, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', marginTop: 2 }}>
                          <div style={{ height: Math.max(0, h - costH - expH), background: 'var(--green)', borderRadius: '2px 2px 0 0' }} />
                          <div style={{ height: costH, background: 'var(--border)', borderRadius: '0 0 2px 2px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="row dim" style={{ justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
                  <span>{from}</span>
                  {series.length > 2 && <span>{series[Math.floor(series.length / 2)].date}</span>}
                  <span>{to}</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid mt" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
            {/* top products */}
            <div className="card">
              <div className="card-title">
                <h2>Top sellers</h2>
              </div>
              {top.length === 0 ? (
                <Empty icon="🏆" title="No sales in range" />
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Product</th>
                      <th className="num">Qty</th>
                      <th className="num">Revenue</th>
                      <th className="num">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.map((p, i) => (
                      <tr key={p.productId}>
                        <td className="dim">{i + 1}</td>
                        <td style={{ fontWeight: 600 }}>{p.name}</td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{fmtTaka(p.revenueCents)}</td>
                        <td className="num" style={{ color: 'var(--green)', fontWeight: 700 }}>
                          {fmtTaka(p.profitCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* expenses by category */}
            <div className="card">
              <div className="card-title">
                <h2>Expenses by category</h2>
              </div>
              {byCat.length === 0 ? (
                <Empty icon="💸" title="No expenses in range" hint="Log daily costing under Daily Costing" />
              ) : (
                <div className="grid" style={{ gap: 8 }}>
                  {byCat.map((c) => {
                    const maxCat = byCat[0].totalCents || 1;
                    return (
                      <div key={c.category}>
                        <div className="between" style={{ fontSize: 13 }}>
                          <span>{c.category}</span>
                          <b>{fmtTaka(c.totalCents)}</b>
                        </div>
                        <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, marginTop: 3 }}>
                          <div style={{ width: `${(c.totalCents / maxCat) * 100}%`, height: '100%', background: 'var(--amber)', borderRadius: 4 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* cashbook */}
          <div className="card mt">
            <div className="card-title">
              <h2>Cash book</h2>
              <div className="row gap-sm dim" style={{ fontSize: 12 }}>
                <span>net movement</span>
                <b style={{ color: cashbook.totals.net >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 16 }}>
                  {fmtTaka(cashbook.totals.net)}
                </b>
              </div>
            </div>
            {cashbook.lines.length === 0 ? (
              <Empty icon="📒" title="No money movement in range" />
            ) : (
              <div className="tbl-wrap" style={{ maxHeight: 320 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="num">Sales received</th>
                      <th className="num">Debt collected</th>
                      <th className="num">Expenses paid</th>
                      <th className="num">Supplier paid</th>
                      <th className="num">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cashbook.lines.map((l: any) => (
                      <tr key={l.date}>
                        <td className="dim">{l.date}</td>
                        <td className="num">{fmtTaka(l.salesIn)}</td>
                        <td className="num">{fmtTaka(l.customerPaid)}</td>
                        <td className="num err-text">{l.expensesOut ? `−${fmtTaka(l.expensesOut)}` : '—'}</td>
                        <td className="num err-text">{l.supplierPaid ? `−${fmtTaka(l.supplierPaid)}` : '—'}</td>
                        <td className="num" style={{ fontWeight: 700, color: l.netCents >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {fmtTaka(l.netCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
