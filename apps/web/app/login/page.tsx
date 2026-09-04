'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pollQrLogin,
  startLogin,
  startQrLogin,
  submitQrPassword,
  verifyLogin,
} from '../lib/auth-api.ts';
import { isDemoMode } from '../lib/events-api.ts';

type Method = 'qr' | 'phone';
type PhoneStep = 'phone' | 'code' | 'password';

/**
 * Telegram sign-in. There is no separate EasyCal account: authorizing your Telegram
 * account both creates the user and signs you in.
 *
 * QR is the default because it needs no phone number and no code — you scan it from
 * a device already signed in, exactly like Telegram Web. The phone flow stays as a
 * fallback for when you have no second device to scan with.
 */
export default function LoginPage() {
  const [method, setMethod] = useState<Method>('qr');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setIsBusy(false);
    }
  }

  if (isDemoMode) {
    return (
      <main className="app-shell">
        <section className="calendar-card">
          <p className="eyebrow">Sign in</p>
          <h1>EasyCal is in preview mode</h1>
          <p className="subheading">
            Set <code>NEXT_PUBLIC_API_BASE_URL</code> to your EasyCal API before signing in.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="calendar-card">
        <p className="eyebrow">Sign in</p>
        <h1>Connect your Telegram account</h1>
        <p className="subheading">
          EasyCal reads the folder you choose, using your own Telegram account. Your
          session is encrypted and never leaves the server.
        </p>

        <div className="filter-tabs" role="tablist" aria-label="Sign-in method">
          <button
            type="button"
            role="tab"
            aria-selected={method === 'qr'}
            onClick={() => { setMethod('qr'); setError(null); }}
          >Scan a QR code</button>
          <button
            type="button"
            role="tab"
            aria-selected={method === 'phone'}
            onClick={() => { setMethod('phone'); setError(null); }}
          >Use a phone number</button>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
          </div>
        )}

        {method === 'qr'
          ? <QrSignIn run={run} isBusy={isBusy} setError={setError} />
          : <PhoneSignIn run={run} isBusy={isBusy} />}
      </section>
    </main>
  );
}

interface PanelProps {
  run: (action: () => Promise<void>) => Promise<void>;
  isBusy: boolean;
  setError?: (message: string | null) => void;
}

function QrSignIn({ run, isBusy, setError }: PanelProps) {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const stopped = useRef(false);

  const begin = useCallback(async () => {
    const pending = await startQrLogin();
    setAttemptId(pending.attemptId);
    setQrImage(pending.qrImage);
    setNeedsPassword(false);
  }, []);

  useEffect(() => {
    stopped.current = false;
    void run(begin);
    return () => { stopped.current = true; };
  }, [begin, run]);

  // Telegram rotates the code every ~30s until it is scanned, so keep polling for a
  // fresh image and for the moment the scan lands.
  useEffect(() => {
    if (!attemptId || needsPassword) return;

    const timer = window.setInterval(() => {
      void (async () => {
        if (stopped.current) return;
        try {
          const result = await pollQrLogin(attemptId);
          if (result.state === 'authenticated') {
            window.location.assign('/');
          } else if (result.state === 'password_required') {
            setNeedsPassword(true);
          } else if (result.qrImage) {
            setQrImage(result.qrImage);
          }
        } catch (caught) {
          setError?.(caught instanceof Error ? caught.message : 'QR sign-in failed.');
          setAttemptId(null);
        }
      })();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [attemptId, needsPassword, setError]);

  if (needsPassword) {
    return (
      <form
        className="correction-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!attemptId) throw new Error('That sign-in attempt expired. Please start again.');
            const outcome = await submitQrPassword(attemptId, password);
            if (outcome.done) window.location.assign('/');
          });
        }}
      >
        <label className="field field-wide">
          <span>Two-factor password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <p className="detail-description">
          Scanned. Your account also has two-step verification enabled.
        </p>
        <div className="dialog-actions">
          <button type="submit" className="accept-button" disabled={isBusy || !password}>
            {isBusy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="correction-fields">
      {qrImage ? (
        // An inline data: URI SVG we generate ourselves; next/image cannot optimise it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qrImage}
          alt="QR code for signing in to Telegram"
          width={220}
          height={220}
          style={{ imageRendering: 'pixelated', background: '#fff', padding: 12, borderRadius: 12 }}
        />
      ) : (
        <p className="detail-description">{isBusy ? 'Generating a code…' : 'No code yet.'}</p>
      )}

      <ol className="detail-description" style={{ paddingLeft: '1.2rem' }}>
        <li>Open Telegram on your phone.</li>
        <li>Go to <strong>Settings → Devices → Link Desktop Device</strong>.</li>
        <li>Point your phone at this code.</li>
      </ol>

      <div className="dialog-actions">
        <button
          type="button"
          className="correct-button"
          disabled={isBusy}
          onClick={() => void run(begin)}
        >
          {isBusy ? 'Refreshing…' : 'New code'}
        </button>
      </div>
    </div>
  );
}

function PhoneSignIn({ run, isBusy }: PanelProps) {
  const [step, setStep] = useState<PhoneStep>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [attemptId, setAttemptId] = useState<string | null>(null);

  if (step === 'phone') {
    return (
      <form
        className="correction-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const { attemptId: id } = await startLogin(phone.trim());
            setAttemptId(id);
            setStep('code');
          });
        }}
      >
        <label className="field field-wide">
          <span>Phone number</span>
          <input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+65 9123 4567"
            autoComplete="tel"
            required
          />
        </label>
        <p className="detail-description">Include your country code.</p>
        <div className="dialog-actions">
          <button type="submit" className="accept-button" disabled={isBusy || !phone.trim()}>
            {isBusy ? 'Sending…' : 'Send code'}
          </button>
        </div>
      </form>
    );
  }

  if (step === 'code') {
    return (
      <form
        className="correction-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!attemptId) throw new Error('That sign-in attempt expired. Please start again.');
            const outcome = await verifyLogin(attemptId, code.trim());
            if (outcome.done) window.location.assign('/');
            else setStep('password');
          });
        }}
      >
        <label className="field field-wide">
          <span>Login code</span>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="12345"
            autoComplete="one-time-code"
            required
          />
        </label>
        <p className="detail-description">Telegram sent this to your other devices.</p>
        <div className="dialog-actions">
          <button type="button" className="correct-button" onClick={() => setStep('phone')}>
            Back
          </button>
          <button type="submit" className="accept-button" disabled={isBusy || !code.trim()}>
            {isBusy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="correction-fields"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!attemptId) throw new Error('That sign-in attempt expired. Please start again.');
          const outcome = await verifyLogin(attemptId, code.trim(), password);
          if (outcome.done) window.location.assign('/');
        });
      }}
    >
      <label className="field field-wide">
        <span>Two-factor password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <p className="detail-description">
        Your Telegram account has two-step verification enabled.
      </p>
      <div className="dialog-actions">
        <button type="submit" className="accept-button" disabled={isBusy || !password}>
          {isBusy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </form>
  );
}
