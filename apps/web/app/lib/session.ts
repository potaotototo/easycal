'use client';

/**
 * Session token storage for the EasyCal API.
 *
 * The API runs on a different origin from this app (it deploys to Cloudflare
 * Workers), so a session cookie would be a third-party cookie and is blocked by
 * default in most browsers. `POST /v1/auth/telegram/verify` also returns a bearer
 * token for exactly this case; we keep it here and send it as an Authorization
 * header instead.
 */

const STORAGE_KEY = 'easycal.sessionToken';

export function readSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing, or storage disabled — treat as signed out.
    return null;
  }
}

export function writeSessionToken(token: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Nothing useful to do; the user simply stays signed out.
  }
}

export function clearSessionToken() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

export function isSignedIn() {
  return readSessionToken() !== null;
}

/** Thrown when the API rejects our session, so callers can send the user to /login. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Your EasyCal session has expired. Please sign in again.');
    this.name = 'NotAuthenticatedError';
  }
}
