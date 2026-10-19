import React, { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../api';
import { useToast, Spinner, Empty, fmtDateTime } from '../ui';

type Entry = {
  seq: number;
  at: string;
  actorName: string;
  actorRole: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  hash: string;
  prevHash: string;
};

const PAGE = 50;

export function AuditPage() {
  const toast = useToast();
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [verify, setVerify] = useState<{ count: number; intact: boolean; brokenAt?: number; reason?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const query = useMemo(
    () => ({ entity, action, from: from ? `${from}T00:00:00.000Z` : undefined, to: to ? `${to}T23:59:59.999Z` : undefined, skip, limit: PAGE }),
    [entity, action, from, to, skip]
  );

  const load = async () => {
    setLoading(true);
    try {
      const r = await api<{ data: Entry[]; meta: { total: number } }>('/audit', { query });
      setItems(r.data);
      setTotal(r.meta.total);
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [query]);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const r = await api<{ data: typeof verify }>('/audit/verify');
      setVerify(r.data);
      toast(r.data!.intact ? `Chain intact — ${r.data!.count} entries` : `BROKEN at #${r.data!.brokenAt}`, r.data!.intact ? 'ok' : 'err');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setVerifying(false);
    }
  };

  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/audit/export.csv?${new URLSearchParams(query as any)}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast(e.message ?? 'Export failed', 'err');
    }
  };

  return (
    <>
      <div className="kpi">
        <div className="card">
          <div className="k-label">Entries</div>
          <div className="k-value">{total.toLocaleString()}</div>
          <div className="k-delta">append-only · hash-chained</div>
        </div>
        <div className="card">
          <div className="k-label">Chain integrity</div>
          <div className="k-value" style={{ fontSize: 17 }}>
            {verify ? (verify.intact ? '✅ intact' : `❌ broken #${verify.brokenAt}`) : 'not verified yet'}
          </div>
          <div className="k-delta">
            <button className="btn sm" onClick={runVerify} disabled={verifying}>
              {verifying ? <Spinner /> : 'Verify now'}
            </button>
          </div>
        </div>
        <div className="card">
          <div className="k-label">Export</div>
          <div className="k-value" style={{ fontSize: 17 }}>
            CSV
          </div>
          <div className="k-delta">
            <button className="btn sm" onClick={exportCsv}>
              Download
            </button>
          </div>
        </div>
      </div>

      <div className="card mt">
        <div className="card-title">
          <h2>Audit log</h2>
          <div className="row wrap">
            <input className="input" style={{ width: 130 }} placeholder="entity e.g. product" value={entity} onChange={(e) => { setEntity(e.target.value); setSkip(0); }} />
            <input className="input" style={{ width: 170 }} placeholder="action e.g. sale.void" value={action} onChange={(e) => { setAction(e.target.value); setSkip(0); }} />
            <input className="input" style={{ width: 150 }} type="date" value={from} onChange={(e) => { setFrom(e.target.value); setSkip(0); }} />
            <input className="input" style={{ width: 150 }} type="date" value={to} onChange={(e) => { setTo(e.target.value); setSkip(0); }} />
            <button className="btn sm" onClick={() => { setEntity(''); setAction(''); setFrom(''); setTo(''); setSkip(0); }}>
              Clear
            </button>
          </div>
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon="🛡" title="No audit entries match" hint="Adjust the filters" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <React.Fragment key={e.seq}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                      <td className="mono dim">{e.seq}</td>
                      <td className="nowrap">{fmtDateTime(e.at)}</td>
                      <td className="nowrap">
                        {e.actorName} <span className="dim">· {e.actorRole}</span>
                      </td>
                      <td>
                        <span className="badge">{e.action}</span>
                      </td>
                      <td className="dim">
                        {e.entity}
                        {e.entityId ? ` · ${String(e.entityId).slice(0, 8)}` : ''}
                      </td>
                      <td className="dim">{open === e.seq ? '▾' : '▸'}</td>
                    </tr>
                    {open === e.seq && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                          <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
                            <DiffCol label="Before" value={e.before} cls="diff-before" />
                            <DiffCol label="After" value={e.after} cls="diff-after" />
                            {e.meta != null && <DiffCol label="Meta" value={e.meta} cls="" />}
                          </div>
                          <div className="dim mono" style={{ marginTop: 8, fontSize: 11 }}>
                            hash {String(e.hash).slice(0, 32)}… ← prev {String(e.prevHash).slice(0, 16)}…
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="between" style={{ marginTop: 12 }}>
          <span className="dim">
            {total ? `${skip + 1}–${Math.min(skip + PAGE, total)} of ${total}` : '0 entries'}
          </span>
          <div className="row">
            <button className="btn sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>
              ← Prev
            </button>
            <button className="btn sm" disabled={skip + PAGE >= total} onClick={() => setSkip(skip + PAGE)}>
              Next →
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function DiffCol({ label, value, cls }: { label: string; value: unknown; cls: string }) {
  if (value == null) return null;
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220 }}>
      <span className={`badge ${cls}`}>{label}</span>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
