import { randomUUID } from "node:crypto";
import { createClient, type GramJsCredentials } from "./gramjs.js";
import type { CompletedLogin, ExpirableAttempt } from "./login.js";

/**
 * QR sign-in, the same flow Telegram Web uses: we display a `tg://login?token=…`
 * code, the person scans it from an already-signed-in device, and Telegram completes
 * the login for us. No phone number, no code to type.
 *
 * Two things make this different from the phone flow:
 *
 *  - Telegram rotates the token roughly every 30 seconds until it is scanned, so the
 *    `qrCode` callback fires repeatedly and the browser has to poll for the current
 *    one rather than being handed a single value.
 *  - There is nothing to submit until either the scan happens or 2FA is required, so
 *    the attempt exposes a state machine instead of a request/response pair.
 *
 * It still needs TELEGRAM_API_ID/TELEGRAM_API_HASH: QR replaces the phone number and
 * code, not the application credential.
 */

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

export interface QrToken {
  /** Encode this as a QR image; scanning it in Telegram authorizes the session. */
  loginUrl: string;
  expiresAt: string;
}

export type QrLoginState = "pending" | "password_required" | "authenticated" | "failed";

/** The slice of a GramJS client this flow needs, so tests can supply a fake. */
export interface QrLoginCapableClient {
  signInUserWithQrCode(
    credentials: GramJsCredentials,
    params: {
      qrCode: (qr: { token: Buffer; expires: number }) => Promise<void>;
      password?: (hint?: string) => Promise<string>;
      onError: (error: Error) => Promise<boolean> | void;
    },
  ): Promise<unknown>;
  getMe(): Promise<{ id: unknown }>;
  session: { save(): unknown };
  disconnect(): Promise<unknown>;
}

export type QrLoginClientFactory = (
  credentials: GramJsCredentials,
) => Promise<QrLoginCapableClient>;

export class QrLoginAttempt implements ExpirableAttempt {
  readonly id = randomUUID();
  readonly createdAt = Date.now();

  #client: QrLoginCapableClient | undefined;
  #token: QrToken | undefined;
  #firstToken = new Deferred<void>();
  #password = new Deferred<string>();
  #passwordRequested = false;
  #login: CompletedLogin | undefined;
  #failure: Error | undefined;

  constructor(
    private readonly credentials: GramJsCredentials,
    private readonly createQrClient: QrLoginClientFactory = (creds) =>
      createClient(creds) as unknown as Promise<QrLoginCapableClient>,
  ) {}

  get state(): QrLoginState {
    if (this.#failure) return "failed";
    if (this.#login) return "authenticated";
    if (this.#passwordRequested) return "password_required";
    return "pending";
  }

  /** The current code to render. Changes as Telegram rotates it. */
  get token(): QrToken | undefined {
    return this.#token;
  }

  get error(): Error | undefined {
    return this.#failure;
  }

  /** Starts the login and resolves once there is a first code to display. */
  async begin(): Promise<void> {
    const client = await this.createQrClient(this.credentials);
    this.#client = client;

    const completion = client
      .signInUserWithQrCode(this.credentials, {
        qrCode: async ({ token, expires }) => {
          // Telegram rotates this until the code is scanned.
          this.#token = {
            loginUrl: `tg://login?token=${token.toString("base64url")}`,
            expiresAt: new Date(expires * 1000).toISOString(),
          };
          this.#firstToken.resolve();
        },
        password: async () => {
          this.#passwordRequested = true;
          return this.#password.promise;
        },
        onError: async (error) => {
          this.#fail(error);
          return true;
        },
      })
      .then(async () => {
        const me = await client.getMe();
        this.#login = {
          telegramUserId: String(me.id),
          sessionString: String(client.session.save()),
        };
      })
      .catch((error: unknown) => {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      });

    // Do not await completion — it only settles once the code is scanned.
    void completion;

    await Promise.race([
      this.#firstToken.promise,
      // If it fails before producing a code, surface that rather than hanging.
      completion.then(() => undefined),
    ]);

    if (this.#failure) throw this.#failure;
  }

  /** Supplies the 2FA password once Telegram has asked for it. */
  async submitPassword(password: string): Promise<void> {
    if (!this.#passwordRequested) {
      throw new Error("Telegram has not asked for a password on this attempt");
    }
    this.#password.resolve(password);
    // Give the sign-in a moment to settle so the next poll reports the outcome.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  get login(): CompletedLogin | undefined {
    return this.#login;
  }

  async dispose(): Promise<void> {
    try {
      await this.#client?.disconnect();
    } catch {
      // A failed disconnect must not mask the original error.
    }
  }

  get expired(): boolean {
    return Date.now() - this.createdAt > ATTEMPT_TTL_MS;
  }

  #fail(error: Error): void {
    this.#failure = error;
    this.#firstToken.resolve();
  }
}
