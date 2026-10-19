import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, getToken, setToken } from './api';

export type Role = 'owner' | 'cashier';
export type User = { uuid: string; name: string; phone: string; role: Role; mustChangePin?: boolean };

type AuthState = {
  user: User | null;
  loading: boolean;
  idleLockMinutes: number;
  readonly: boolean;
  login: (phone: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  locked: boolean;
  unlock: (pin: string) => Promise<void>;
  can: (perm: Permission) => boolean;
};

export type Permission =
  | 'viewCost'
  | 'manageProducts'
  | 'voidSale'
  | 'giveDiscount'
  | 'manageInventory'
  | 'viewReports'
  | 'manageExpenses'
  | 'viewAudit'
  | 'manageSettings'
  | 'manageUsers';

/** Server is the enforcer (stripFields); this only shapes the UI. */
const ROLE_PERMS: Record<Role, Permission[]> = {
  owner: [
    'viewCost',
    'manageProducts',
    'voidSale',
    'giveDiscount',
    'manageInventory',
    'viewReports',
    'manageExpenses',
    'viewAudit',
    'manageSettings',
    'manageUsers',
  ],
  cashier: ['giveDiscount'],
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [idleLockMinutes, setIdleLockMinutes] = useState(5);
  const [readonly, setReadonly] = useState(false);

  // restore session on reload
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<{ user: User; idleLockMinutes: number; readonly: boolean }>('/auth/session')
      .then((r) => {
        setUser(r.user);
        setIdleLockMinutes(r.idleLockMinutes ?? 5);
        setReadonly(!!r.readonly);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (phone: string, pin: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { phone, pin },
    });
    setToken(r.token);
    setUser(r.user);
    setLocked(false);
  }, []);

  const unlock = useCallback(async (pin: string) => {
    if (!user) throw new Error('not signed in');
    try {
      // identity comes from the bearer token — /auth/session carries no phone
      await api('/auth/unlock', { method: 'POST', body: { pin } });
      setLocked(false);
    } catch (e: any) {
      if (e?.code === 'UNAUTHORIZED') {
        // token expired while locked → fall back to a fresh login
        setToken(null);
        setUser(null);
        setLocked(false);
        return;
      }
      throw e;
    }
  }, [user]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setToken(null);
    setUser(null);
    setLocked(false);
  }, []);

  const can = useCallback(
    (perm: Permission) => (user ? ROLE_PERMS[user.role]?.includes(perm) ?? false : false),
    [user]
  );

  // ---- idle lock -------------------------------------------------------
  const idleMs = idleLockMinutes * 60_000;
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!user || idleMs <= 0) return;
    const reset = () => {
      if (timer.current) window.clearTimeout(timer.current);
      // only lock while the tab is visible — don't lock in the background
      timer.current = window.setTimeout(
        () => document.visibilityState === 'visible' && setLocked(true),
        idleMs
      );
    };
    const onVis = () => document.visibilityState === 'visible' && reset();
    reset();
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user, idleMs]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, idleLockMinutes, readonly, login, logout, locked, unlock, can }),
    [user, loading, idleLockMinutes, readonly, login, logout, locked, unlock, can]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
