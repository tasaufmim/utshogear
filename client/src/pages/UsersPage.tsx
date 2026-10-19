import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast, Spinner, Modal, Empty, Badge } from '../ui';
import { useAuth } from '../auth';

type UserRow = {
  uuid: string;
  name: string;
  phone: string;
  role: 'owner' | 'cashier';
  active: boolean;
  mustChangePin: boolean;
  lastLoginAt?: string | null;
};

export function UsersPage() {
  const toast = useToast();
  const { user, can } = useAuth();
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ open: boolean; value: UserRow | null }>({ open: false, value: null });
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [chpwd, setChpwd] = useState(false);

  const load = () => {
    setLoading(true);
    api<{ data: UserRow[] }>('/users')
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggleActive = async (u: UserRow) => {
    try {
      await api(`/users/${u.uuid}`, { method: 'PATCH', body: { active: !u.active } });
      toast(u.active ? `${u.name} deactivated` : `${u.name} reactivated`, 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-title">
          <h2>Users & PINs</h2>
          <div className="row">
            <button className="btn" onClick={() => setChpwd(true)}>
              🔒 Change my PIN
            </button>
            {can('manageUsers') && (
              <button className="btn primary" onClick={() => setForm({ open: true, value: null })}>
                + New user
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon="🔑" title="No users" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone (login)</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th style={{ width: 210 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((u) => (
                  <tr key={u.uuid} style={u.uuid === user?.uuid ? { background: 'var(--brand-50)' } : undefined}>
                    <td style={{ fontWeight: 650 }}>
                      {u.name} {u.uuid === user?.uuid && <span className="badge info">you</span>}
                    </td>
                    <td className="mono dim">{u.phone}</td>
                    <td>
                      <Badge kind={u.role === 'owner' ? 'info' : ''}>{u.role}</Badge>
                    </td>
                    <td>
                      {u.active ? <Badge kind="ok">active</Badge> : <Badge kind="bad">deactivated</Badge>}
                      {u.mustChangePin && <Badge kind="warn">PIN change due</Badge>}
                    </td>
                    <td className="dim nowrap">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                    <td className="right nowrap">
                      {can('manageUsers') && (
                        <>
                          <button className="btn sm" onClick={() => setForm({ open: true, value: u })}>
                            Edit
                          </button>{' '}
                          <button className="btn sm" onClick={() => setResetFor(u)}>
                            Reset PIN
                          </button>{' '}
                          <button
                            className={`btn sm ${u.active ? 'danger' : ''}`}
                            disabled={u.uuid === user?.uuid}
                            title={u.uuid === user?.uuid ? 'You cannot deactivate yourself' : undefined}
                            onClick={() => toggleActive(u)}
                          >
                            {u.active ? 'Deactivate' : 'Activate'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          PINs are stored only as bcrypt hashes — nobody, not even the system, can read them back.
          "Reset PIN" forces the user to choose a new one at their next login.
        </p>
      </div>

      {form.open && (
        <UserForm
          value={form.value}
          onClose={() => setForm({ open: false, value: null })}
          onSaved={() => {
            setForm({ open: false, value: null });
            load();
          }}
        />
      )}
      {resetFor && (
        <ResetPinModal
          target={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => {
            setResetFor(null);
            load();
          }}
        />
      )}
      {chpwd && <ChangeMyPinModal onClose={() => setChpwd(false)} />}
    </>
  );
}

/* ------------------------------- create/edit ------------------------------ */
function UserForm({ value, onClose, onSaved }: { value: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isEdit = !!value;
  const [f, setF] = useState({
    name: value?.name ?? '',
    phone: value?.phone ?? '',
    role: value?.role ?? 'cashier',
    pin: '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!f.name.trim()) return toast('Name required', 'err');
    if (!isEdit && !/^01\d{9}$/.test(f.phone)) return toast('Phone must be 11 digits, start 01', 'err');
    if (!isEdit && !/^\d{4,6}$/.test(f.pin)) return toast('PIN must be 4–6 digits', 'err');
    setBusy(true);
    try {
      if (isEdit) {
        await api(`/users/${value.uuid}`, { method: 'PATCH', body: { name: f.name, role: f.role } });
        toast('User updated', 'ok');
      } else {
        await api('/users', { method: 'POST', body: f });
        toast('User created — they must change the PIN at first login', 'ok');
      }
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit — ${value.name}` : 'New user'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="field">
          <label>Name *</label>
          <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Role *</label>
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}>
            <option value="cashier">Cashier — sells, no costs/reports</option>
            <option value="owner">Owner — full access</option>
          </select>
        </div>
        {!isEdit && (
          <>
            <div className="field">
              <label>Phone (login) *</label>
              <input
                className="input mono"
                placeholder="017XXXXXXXX"
                value={f.phone}
                onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 11) })}
              />
            </div>
            <div className="field">
              <label>First PIN *</label>
              <input
                className="input mono"
                inputMode="numeric"
                placeholder="4–6 digits"
                value={f.pin}
                onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------------- reset PIN ------------------------------ */
function ResetPinModal({ target, onClose, onDone }: { target: UserRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!/^\d{4,6}$/.test(pin)) return toast('PIN must be 4–6 digits', 'err');
    setBusy(true);
    try {
      await api(`/users/${target.uuid}/reset-pin`, { method: 'POST', body: { pin } });
      toast(`PIN reset for ${target.name} — they must change it at next login`, 'ok');
      onDone();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Reset PIN — ${target.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : 'Reset PIN'}
          </button>
        </>
      }
    >
      <p className="muted">
        Set a temporary PIN for <b>{target.name}</b> ({target.phone}). They will be forced to choose a
        new one at their next login. This action is recorded in the audit log.
      </p>
      <input
        className="input mono center"
        style={{ fontSize: 22, letterSpacing: 8, marginTop: 14 }}
        inputMode="numeric"
        maxLength={6}
        autoFocus
        placeholder="••••"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
    </Modal>
  );
}

/* ------------------------------ change own PIN ---------------------------- */
function ChangeMyPinModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ oldPin: '', newPin: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!/^\d{4,6}$/.test(f.oldPin)) return toast('Enter your current PIN', 'err');
    if (!/^\d{4,6}$/.test(f.newPin)) return toast('New PIN must be 4–6 digits', 'err');
    if (f.newPin !== f.confirm) return toast('PINs do not match', 'err');
    setBusy(true);
    try {
      await api('/users/change-pin', { method: 'POST', body: { oldPin: f.oldPin, newPin: f.newPin } });
      toast('PIN changed', 'ok');
      onClose();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change my PIN"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : 'Change PIN'}
          </button>
        </>
      }
    >
      <div className="grid" style={{ maxWidth: 260, margin: '0 auto' }}>
        <div className="field">
          <label>Current PIN</label>
          <input
            className="input mono center"
            type="password"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            value={f.oldPin}
            onChange={(e) => setF({ ...f, oldPin: e.target.value.replace(/\D/g, '') })}
          />
        </div>
        <div className="field">
          <label>New PIN</label>
          <input
            className="input mono center"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={f.newPin}
            onChange={(e) => setF({ ...f, newPin: e.target.value.replace(/\D/g, '') })}
          />
        </div>
        <div className="field">
          <label>Confirm new PIN</label>
          <input
            className="input mono center"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={f.confirm}
            onChange={(e) => setF({ ...f, confirm: e.target.value.replace(/\D/g, '') })}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
      </div>
    </Modal>
  );
}
