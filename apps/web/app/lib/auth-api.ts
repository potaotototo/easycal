'use client';

import { apiBaseUrl } from './events-api.ts';
import { readSessionToken, writeSessionToken } from './session.ts';

/**
 * Telegram sign-in. The account IS the EasyCal identity, so this is both signup and
 * login. It is two requests because Telegram sends a code in between, and a third
 * state when the account has two-factor authentication enabled.
 */

export interface StartLoginResult {
  attemptId: string;
}

function authUrl(path: string) {
  return `${apiBaseUrl ?? ''}${path}`;
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? null;
  } catch {
    return null;
  }
}

export async function startLogin(phone: string): Promise<StartLoginResult> {
  const response = await fetch(authUrl('/v1/auth/telegram/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      phone,
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });

  if (!response.ok) {
    const error = await readError(response);
    if (error === 'telegram_not_configured') {
      throw new Error('The server has no Telegram credentials configured yet.');
    }
    if (response.status === 400) {
      throw new Error('That phone number was not accepted. Include the country code.');
    }
    throw new Error('Telegram would not start the sign-in. Please try again.');
  }

  return (await response.json()) as StartLoginResult;
}

export type VerifyOutcome = { done: true } | { done: false; needsPassword: true };

/**
 * Returns `needsPassword` rather than throwing when 2FA is on, so the caller can
 * simply reveal a password field and call again with the same attempt id.
 */
export async function verifyLogin(
  attemptId: string,
  code: string,
  password?: string,
): Promise<VerifyOutcome> {
  const response = await fetch(authUrl('/v1/auth/telegram/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(password ? { attemptId, code, password } : { attemptId, code }),
  });

  if (response.status === 409) {
    return { done: false, needsPassword: true };
  }

  if (response.status === 410) {
    throw new Error('That sign-in attempt expired. Please start again.');
  }

  if (!response.ok) {
    throw new Error('That code was not accepted. Please check it and try again.');
  }

  const body = (await response.json()) as { sessionToken?: string };
  if (!body.sessionToken) {
    throw new Error('The server did not return a session. Please try again.');
  }

  writeSessionToken(body.sessionToken);
  return { done: true };
}

export async function logout() {
  await fetch(authUrl('/v1/auth/logout'), {
    method: 'POST',
    headers: { Accept: 'application/json', ...authHeader() },
  }).catch(() => undefined);
}

function authHeader(): Record<string, string> {
  const token = readSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
