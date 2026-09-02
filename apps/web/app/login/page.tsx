'use client';

import { useState } from 'react';
import { startLogin, verifyLogin } from '../lib/auth-api';
import { isDemoMode } from '../lib/events-api';

type Step = 'phone' | 'code' | 'password';

/**
 * Telegram sign-in.
 *
 * There is no separate EasyCal account: authorizing your Telegram account both
 * creates the user and signs you in. Telegram sends a code between the two steps,
 * and asks for your account password as well when you have 2FA enabled.
 */
export default function LoginPage() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [attemptId, setAttemptId] = useState<string | null>(null);
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

  const submitPhone = () =>
    run(async () => {
      const { attemptId: id } = await startLogin(phone.trim());
      setAttemptId(id);
      setStep('code');
    });

  const submitCode = () =>
    run(async () => {
      if (!attemptId) throw new Error('That sign-in attempt expired. Please start again.');
      const outcome = await verifyLogin(attemptId, code.trim());
      if (outcome.done) {
        window.location.assign('/');
        return;
      }
      // Two-factor authentication is enabled on this account.
      setStep('password');
    });

  const submitPassword = () =>
    run(async () => {
      if (!attemptId) throw new Error('That sign-in attempt expired. Please start again.');
      const outcome = await verifyLogin(attemptId, code.trim(), password);
      if (outcome.done) window.location.assign('/');
    });

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

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
          </div>
        )}

        {step === 'phone' && (
          <form
            className="correction-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPhone();
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
        )}

        {step === 'code' && (
          <form
            className="correction-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
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
        )}

        {step === 'password' && (
          <form
            className="correction-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPassword();
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
        )}
      </section>
    </main>
  );
}
