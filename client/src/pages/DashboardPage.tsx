import React, { useEffect, useState } from 'react';
import { api, fmtTaka } from '../api';
import { useAuth } from '../auth';
import { Empty, Spinner, Badge, fmtDateTime } from '../ui';

/** Business date in the shop's timezone (Asia/Dhaka) as YYYY-MM-DD. */
export const bizToday = () => {
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

export function DashboardPage() {
  const { user, readonly } = useAuth();
  const owner = user?.role === 'owner';

  const [range, setRange] = useState<'today' | 'yesterday' | 'month'>('today');
  const [summary, setSummary] = useState<any>(null);
  const [sales, setSales] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const { from, to } = React.useMemo(() => {
    const t = bizToday();
    if (range === 'today') return { from: t, to: t };
    if (range === 'yesterday') return { from: shiftDay(t, -1), to: shiftDay(t, -1) };
    return { from: `${t.slice(0, 7)}-01`, to: t };
  }, [range]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<any>('/reports/summary', { query: { from, to } }),
      api<{ data: any[] }>('/sales', { query: { from, to, limit: 8 } }),
    ])
      .then(([s, sl]) => {
        setSummary(s.data);
        setSales(sl.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [from, to]);

  const s = summary;
  const label = range === 'today' ? 'Today' : range === 'yesterday' ? 'Yesterday' : 'This month';

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Welcome</div>
          <div className="k-value" style={{ fontSize: 20 }}>{user?.name}</div>
          <div className="k-delta up">
            {user?.role}
            {readonly ? ' · read-only mirror' : ''}
          </div>
        </div>

        <div className="card">
          <div className="k-label">{label} sales</div>
          {loading || !s ? (
            <Spinner />
          ) : (
            <>
              <div className="k-value">{fmtTaka(s.sales.totalCents)}</div>
              <div className="k-delta">{s.sales.count} receipt(s)</div>
            </>
          )}
        </div>

        {owner && (
          <div className="card">
            <div className="k-label">{label} net profit</div>
            {loading || !s ? (
              <Spinner />
            ) : (
              <>
                <div className="k-value" style={{ color: s.netCents >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmtTaka(s.netCents)}
                </div>
                <div className="k-delta">
                  profit {fmtTaka(s.sales.profitCents)} − expenses {fmtTaka(s.expenses.totalCents)}
                </div>
              </>
            )}
          </div>
        )}

        <div className="card">
          <div className="k-label">Low stock</div>
          {loading || !s ? (
            <Spinner />
          ) : (
            <>
              <div className="k-value" style={{ color: s.lowStock > 0 ? 'var(--amber)' : undefined }}>
                {s.lowStock}
              </div>
              <div className="k-delta">item(s) at reorder level</div>
            </>
          )}
        </div>
      </div>

      <div className="row wrap" style={{ margin: '12px 0' }}>
        {(['today', 'yesterday', 'month'] as const).map((r) => (
          <button key={r} className={`btn sm ${range === r ? 'primary' : ''}`} onClick={() => setRange(r)}>
            {r === 'month' ? 'This month' : r[0].toUpperCase() + r.slice(1)}
          </button>
        ))}
        <span className="dim" style={{ marginLeft: 'auto' }}>
          {from === to ? from : `${from} → ${to}`} · business dates (Asia/Dhaka)
        </span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 320px', alignItems: 'start' }}>
        {/* recent sales */}
        <div className="card">
          <div className="card-title">
            <h2>Recent receipts</h2>
            <a className="btn sm" href="/pos">
              Open POS →
            </a>
          </div>
          {loading ? (
            <div className="center" style={{ padding: 26 }}>
              <Spinner />
            </div>
          ) : sales.length === 0 ? (
            <Empty icon="🛒" title="No sales in this period" hint="The POS writes receipts the moment they happen" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>When</th>
                    <th>Customer</th>
                    <th className="num">Total</th>
                    {owner && <th className="num">Profit</th>}
                    <th>Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sl) => (
                    <tr key={sl.uuid}>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        {sl.receiptNo}
                      </td>
                      <td className="dim nowrap">{fmtDateTime(sl.createdAt)}</td>
                      <td>{sl.customerName}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtTaka(sl.totalCents)}
                      </td>
                      {owner && <td className="num dim">{fmtTaka(sl.profitCents ?? 0)}</td>}
                      <td>
                        <Badge kind={sl.payment?.method === 'due' ? 'bad' : 'ok'}>{sl.payment?.method}</Badge>
                        {sl.status === 'voided' && <Badge kind="bad">voided</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* side: debt + low stock */}
        <div className="grid" style={{ gap: 12 }}>
          <div className="card">
            <div className="card-title">
              <h3>💬 Customers in debt</h3>
              <a className="btn sm" href="/customers">
                Collect →
              </a>
            </div>
            {!s ? (
              <Spinner />
            ) : s.receivable?.count > 0 ? (
              <>
                <div className="k-value" style={{ color: 'var(--red)' }}>
                  {fmtTaka(s.receivable.totalCents)}
                </div>
                <div className="dim">{s.receivable.count} customer(s) owe the shop</div>
              </>
            ) : (
              <span className="dim">All dues settled 🎉</span>
            )}
          </div>

          <div className="card">
            <div className="card-title">
              <h3>🔔 Reorder list</h3>
              <a className="btn sm" href="/inventory">
                Restock →
              </a>
            </div>
            {!s ? (
              <Spinner />
            ) : s.lowStockItems?.length === 0 ? (
              <span className="dim">Everything is stocked up</span>
            ) : (
              <div className="tbl-wrap" style={{ maxHeight: 220 }}>
                <table className="tbl">
                  <tbody>
                    {s.lowStockItems.map((p: any) => (
                      <tr key={p.uuid}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                        </td>
                        <td className="num err-text" style={{ fontWeight: 700 }}>
                          {p.stock}/{p.level}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {owner && (
            <div className="card">
              <div className="card-title">
                <h3>💰 Owed to shop</h3>
              </div>
              {!s ? (
                <Spinner />
              ) : (
                <>
                  <div className="k-value">{fmtTaka(s.receivable?.totalCents ?? 0)}</div>
                  <div className="dim">{s.receivable?.count ?? 0} debtor(s) · collected via Customers → Receive payment</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
