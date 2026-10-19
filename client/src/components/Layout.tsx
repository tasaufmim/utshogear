import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, Permission } from '../auth';
import { useToast } from '../ui';
import { api } from '../api';

type NavItem = { to: string; label: string; ico: string; perm?: Permission; show?: string };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Counter',
    items: [
      { to: '/', label: 'Dashboard', ico: '▦' },
      { to: '/pos', label: 'POS — Sell', ico: '🛒' },
    ],
  },
  {
    section: 'Catalog',
    items: [
      { to: '/products', label: 'Products', ico: '📦', perm: 'manageProducts' },
      { to: '/categories', label: 'Categories', ico: '🏷', perm: 'manageProducts' },
      { to: '/barcode', label: 'Barcode & Labels', ico: '▮▯▮', perm: 'manageProducts' },
    ],
  },
  {
    section: 'Stock',
    items: [
      { to: '/inventory', label: 'Inventory', ico: '🗄', perm: 'manageInventory' },
      { to: '/purchases', label: 'Purchases', ico: '🧾', perm: 'manageInventory' },
      { to: '/suppliers', label: 'Suppliers', ico: '🚚', perm: 'manageInventory' },
      { to: '/returns', label: 'Returns', ico: '↩', show: 'all' },
    ],
  },
  {
    section: 'Money',
    items: [
      { to: '/customers', label: 'Customers & Debt', ico: '👤' },
      { to: '/expenses', label: 'Daily Costing', ico: '💰', perm: 'manageExpenses' },
      { to: '/reports', label: 'Reports', ico: '📈', perm: 'viewReports' },
    ],
  },
  {
    section: 'System',
    items: [
      { to: '/audit', label: 'Audit Log', ico: '🛡', perm: 'viewAudit' },
      { to: '/users', label: 'Users & PINs', ico: '🔑', perm: 'manageUsers' },
      { to: '/settings', label: 'Settings', ico: '⚙', perm: 'manageSettings' },
    ],
  },
];

export function Layout() {
  const { user, logout, can, readonly, locked } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [online, setOnline] = useState(navigator.onLine);
  const [health, setHealth] = useState<{ mode: string } | null>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    api<{ mode: string }>('/health')
      .then((h) => setHealth(h))
      .catch(() => setHealth(null));
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const isRo = readonly || health?.mode === 'ro';

  const pageTitle =
    NAV.flatMap((s) => s.items).find((i) => i.to === location.pathname)?.label ??
    (location.pathname === '/' ? 'Dashboard' : 'UGR');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">UGR</div>
          <div>
            <b>UTSHO GEAR</b>
            <span>POS & Inventory</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((group) => {
            const items = group.items.filter((i) => !i.perm || can(i.perm));
            if (items.length === 0) return null;
            return (
              <React.Fragment key={group.section}>
                <div className="nav-label">{group.section}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                    <span className="ico">{i.ico}</span>
                    {i.label}
                  </NavLink>
                ))}
              </React.Fragment>
            );
          })}
        </nav>

        <div style={{ marginTop: 'auto', padding: 14, borderTop: '1px solid #1e293b' }}>
          <div className="dim" style={{ color: '#64748b' }}>
            v1.0.0
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="page-title">{pageTitle}</span>
          <span className="spacer" />
          <span className={`sync-pill ${online ? '' : 'off'}`}>
            {online ? (isRo ? '☁ read-only view' : '● online') : '○ offline — selling locally'}
          </span>
          <Bell />
          <div className="row gap-sm">
            <div className="avatar">{user?.name?.[0] ?? '?'}</div>
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontWeight: 650, fontSize: 13 }}>{user?.name}</div>
              <div className="dim">{user?.role}</div>
            </div>
          </div>
          <button
            className="btn sm"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Sign out
          </button>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      {locked && <IdleLock />}
    </div>
  );
}

/** PIN overlay shown after inactivity — implemented in auth-driven state. */
function IdleLock() {
  const { user, unlock } = useAuth();
  const toast = useToast();
  const [pin, setPin] = useState('');

  const submit = async () => {
    try {
      await unlock(pin);
      setPin('');
    } catch (e: any) {
      toast(e?.message ?? 'Incorrect PIN', 'err');
      setPin('');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length >= 6 ? p : p + e.key));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="lock-overlay">
      <div className="login-card" style={{ maxWidth: 340 }}>
        <div className="login-logo">🔒</div>
        <h2>Locked</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          {user?.name}, enter your PIN to continue.
        </p>
        <div className="pin-dots">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <i key={i} className={i < pin.length ? 'on' : ''} />
          ))}
        </div>
        <Keypad
          onKey={(k) => {
            if (k === '<') setPin((p) => p.slice(0, -1));
            else if (k === 'OK') submit();
            else setPin((p) => (p.length >= 6 ? p : p + k));
          }}
        />
      </div>
    </div>
  );
}

export function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '<', '0', 'OK'];
  return (
    <div className="keypad">
      {keys.map((k) => (
        <button key={k} onClick={() => onKey(k)} style={k === 'OK' ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : undefined}>
          {k === '<' ? '⌫' : k}
        </button>
      ))}
    </div>
  );
}

/** Reminder bell — low-stock + due reminders, fully offline (reads Mongo). */
function Bell() {
  const { can } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = () =>
    api<any>('/notifications')
      .then((r) => {
        setItems(r.data);
        setUnread(r.meta?.unreadCount ?? 0);
      })
      .catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const markRead = async (id: string) => {
    try {
      await api(`/notifications/${id}/read`, { method: 'POST' });
      load();
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn sm" onClick={() => setOpen((o) => !o)} title="Reminders">
        🔔
        {unread > 0 && (
          <span className="badge bad" style={{ marginLeft: 4 }}>
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 40,
            width: 340,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-lg)',
            zIndex: 60,
            padding: 10,
          }}
        >
          <div className="between" style={{ marginBottom: 6 }}>
            <b>Reminders</b>
            <button className="btn ghost sm" onClick={load}>
              ↻
            </button>
          </div>
          {items.length === 0 ? (
            <div className="dim" style={{ padding: 12 }}>
              Nothing waiting — all clear
            </div>
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {items.map((n) => (
                <div
                  key={n.uuid}
                  onClick={() => markRead(n.uuid)}
                  style={{
                    padding: '7px 8px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: n.readAt ? undefined : 'var(--brand-50)',
                  }}
                  title="Click to mark as read"
                >
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{n.title}</div>
                  <div className="dim" style={{ fontSize: 12 }}>
                    {n.body}
                  </div>
                </div>
              ))}
            </div>
          )}
          {can('manageInventory') && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    const r = await api<any>('/notifications/low-stock/queue', { method: 'POST' });
                    toast(`Queued ${r.data.queued} low-stock reminder(s)`, 'ok');
                    load();
                  } catch (e: any) {
                    toast(e.message, 'err');
                  }
                }}
              >
                🔔 Low stock
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    const r = await api<any>('/notifications/due-reminders/queue', { method: 'POST' });
                    toast(`Queued ${r.data.queued} debt reminder(s)`, 'ok');
                    load();
                  } catch (e: any) {
                    toast(e.message, 'err');
                  }
                }}
              >
                💬 Debt
              </button>
              <button
                className="btn sm"
                title="Send via SMS provider if configured — otherwise stays in-app"
                onClick={async () => {
                  try {
                    const r = await api<any>('/notifications/send', { method: 'POST', body: { limit: 20 } });
                    toast(r.data.enabled ? `Sent ${r.data.sent}/${r.data.tried}` : r.data.note, r.data.enabled ? 'ok' : 'err');
                    load();
                  } catch (e: any) {
                    toast(e.message, 'err');
                  }
                }}
              >
                📨 Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
