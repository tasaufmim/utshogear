import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Keypad } from '../components/Layout';
import { useToast } from '../ui';

export function LoginPage() {
  const { login, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'phone' | 'pin'>('phone');

  useEffect(() => {
    if (!loading && user) navigate((location.state as any)?.from ?? '/', { replace: true });
  }, [loading, user, navigate, location]);

  const submit = async () => {
    if (step === 'phone') {
      if (phone.replace(/\D/g, '').length < 6) return toast('Enter your phone number', 'err');
      setStep('pin');
      return;
    }
    if (pin.length < 4) return toast('Enter your PIN', 'err');
    setBusy(true);
    try {
      await login(phone, pin);
      navigate((location.state as any)?.from ?? '/', { replace: true });
    } catch (e: any) {
      toast(e?.message ?? 'Login failed', 'err');
      setPin('');
      if (e?.code === 'ROLE_REQUIRED') return;
    } finally {
      setBusy(false);
    }
  };

  const onKey = (k: string) => {
    if (k === '<') setPin((p) => p.slice(0, -1));
    else if (k === 'OK') submit();
    else setPin((p) => (p.length >= 6 ? p : p + k));
  };

  useEffect(() => {
    const onKeyGlobal = (e: KeyboardEvent) => {
      if (step !== 'pin') return;
      if (/^\d$/.test(e.key)) setPin((p) => (p.length >= 6 ? p : p + e.key));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') submit();
    };
    window.addEventListener('keydown', onKeyGlobal);
    return () => window.removeEventListener('keydown', onKeyGlobal);
  });

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <img src="/logo.png" alt="" />
          <h1 className="sr-only">Utsho Gear — Motorcycle Accessories</h1>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          {step === 'phone' ? 'Sign in to the counter' : `Continue as ${phone}`}
        </p>

        <div style={{ marginTop: 20 }}>
          {step === 'phone' ? (
            <div className="field">
              <label>Phone number</label>
              <input
                className="input"
                autoFocus
                inputMode="numeric"
                placeholder="017…"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
          ) : (
            <>
              <div className="pin-dots">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <i key={i} className={i < pin.length ? 'on' : ''} />
                ))}
              </div>
              <Keypad onKey={onKey} />
            </>
          )}
        </div>

        <button
          className="btn primary lg block"
          style={{ marginTop: 16 }}
          onClick={submit}
          disabled={busy}
        >
          {busy ? 'Signing in…' : step === 'phone' ? 'Continue' : 'Sign in'}
        </button>

        {step === 'pin' && (
          <button
            className="btn ghost block"
            style={{ marginTop: 8 }}
            onClick={() => {
              setStep('phone');
              setPin('');
            }}
          >
            ← Change number
          </button>
        )}

        <div className="hint center" style={{ marginTop: 18 }}>
          Traveling is Life
        </div>
      </div>
    </div>
  );
}
