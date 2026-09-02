import { EnvKeyProvider, encryptOnly, getPool, type KeyProvider, type Pool } from "@easycal/db";
import { LoginAttemptStore } from "@easycal/worker/telegram/login";
import type { LoginClientFactory } from "@easycal/worker/telegram/login";
import type { GramJsCredentials } from "@easycal/worker/telegram/gramjs";
import type { Env } from "./env.js";

export interface AppContext {
  db: Pool;
  /**
   * Encrypt-only on purpose: the API stores Telegram sessions but must not be able
   * to read them back. Decryption belongs to the worker (docs/architecture.md).
   */
  keys: Pick<KeyProvider, "encrypt">;
  telegram: GramJsCredentials | null;
  loginAttempts: LoginAttemptStore;
  /**
   * Seams for tests, so the auth routes can be exercised without reaching Telegram.
   * Both default to the real implementations in production.
   */
  createLoginClient?: LoginClientFactory;
  cacheFolders?: (connectionId: string, sessionString: string) => Promise<void>;
}

export function buildContext(env: Env): AppContext {
  return {
    db: getPool(),
    keys: env.SESSION_ENCRYPTION_KEY
      ? encryptOnly(new EnvKeyProvider(env.SESSION_ENCRYPTION_KEY))
      : missingKeyProvider(),
    telegram:
      env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH
        ? { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH }
        : null,
    loginAttempts: new LoginAttemptStore(),
  };
}

/** Fails loudly at use time rather than letting the API start half-configured. */
function missingKeyProvider(): Pick<KeyProvider, "encrypt"> {
  return {
    encrypt: () => {
      throw new Error("SESSION_ENCRYPTION_KEY is not configured; cannot store a connection");
    },
  };
}
