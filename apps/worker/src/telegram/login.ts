import { randomUUID } from "node:crypto";
import { createClient, type GramJsCredentials } from "./gramjs.js";

/**
 * GramJS drives sign-in with callbacks it awaits (`phoneCode`, `password`), but our
 * API is two HTTP requests. An attempt therefore holds the in-flight login and
 * hands each callback a promise that a later request resolves.
 *
 * The attempt is process-local, so v1 runs a single API instance. See apps/api/README.md.
 */

const ATTEMPT_TTL_MS = 5 * 60 * 1000;

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

export interface CompletedLogin {
  telegramUserId: string;
  /** Encrypt immediately; never log or return this. */
  sessionString: string;
}

/**
 * The slice of a GramJS client this flow needs. Structural rather than the concrete
 * `TelegramClient` so tests can drive the two-step state machine with a fake and no
 * network — the same seam `TelegramPort` provides for sync.
 */
export interface LoginCapableClient {
  start(params: {
    phoneNumber: string;
    phoneCode: () => Promise<string>;
    password: () => Promise<string>;
    onError: (error: Error) => Promise<boolean> | void;
  }): Promise<unknown>;
  getMe(): Promise<{ id: unknown }>;
  session: { save(): unknown };
  disconnect(): Promise<unknown>;
}

export type LoginClientFactory = (
  credentials: GramJsCredentials,
) => Promise<LoginCapableClient>;

export class LoginAttempt {
  readonly id = randomUUID();
  readonly createdAt = Date.now();

  #client: LoginCapableClient | undefined;
  #code = new Deferred<string>();
  #password = new Deferred<string>();
  #codeRequested = new Deferred<void>();
  #passwordRequested = false;
  #completion: Promise<CompletedLogin> | undefined;
  #settled = false;

  constructor(
    private readonly credentials: GramJsCredentials,
    private readonly phoneNumber: string,
    /** Overridden in tests; defaults to a real connected GramJS client. */
    private readonly createLoginClient: LoginClientFactory = (creds) => createClient(creds),

  ) {}

  get passwordRequested(): boolean {
    return this.#passwordRequested;
  }

  /**
   * Starts sign-in and resolves once Telegram has actually sent the code, so the
   * caller only gets an attempt id after there is something to type in.
   */
  async begin(): Promise<void> {
    const client = await this.createLoginClient(this.credentials);
    this.#client = client;

    this.#completion = client
      .start({
        phoneNumber: this.phoneNumber,
        phoneCode: async () => {
          this.#codeRequested.resolve();
          return this.#code.promise;
        },
        password: async () => {
          this.#passwordRequested = true;
          return this.#password.promise;
        },
        onError: async (error) => {
          this.#codeRequested.reject(error);
          return true;
        },
      })
      .then(async () => {
        const me = await client.getMe();
        return {
          telegramUserId: String(me.id),
          sessionString: String(client.session.save()),
        };
      });

    // Surface a rejection here rather than as an unhandled rejection later.
    this.#completion.catch(() => {});

    await Promise.race([
      this.#codeRequested.promise,
      this.#completion.then(() => undefined),
    ]);
  }

  /**
   * Supplies the login code and, when 2FA is enabled, the password. Returns
   * `needsPassword` when Telegram asked for one that the caller did not provide.
   */
  async complete(
    code: string,
    password?: string,
  ): Promise<{ done: true; login: CompletedLogin } | { done: false; needsPassword: true }> {
    if (!this.#completion) throw new Error("Login attempt was never started");

    if (!this.#settled) {
      this.#settled = true;
      this.#code.resolve(code);
    }

    if (password !== undefined) {
      this.#password.resolve(password);
      return { done: true, login: await this.#completion };
    }

    // Either the login finishes, or the password callback fires and we must ask.
    const outcome = await Promise.race([
      this.#completion.then((login) => ({ kind: "done" as const, login })),
      this.#waitForPasswordPrompt(),
    ]);

    if (outcome.kind === "done") return { done: true, login: outcome.login };
    return { done: false, needsPassword: true };
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

  #waitForPasswordPrompt(): Promise<{ kind: "password" }> {
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.#passwordRequested) {
          clearInterval(poll);
          resolve({ kind: "password" });
        }
      }, 50);
      poll.unref?.();
    });
  }
}

/** Short-lived, in-memory store of in-flight logins, swept on every access. */
/** What the store needs of an attempt, so it can hold phone and QR alike. */
export interface ExpirableAttempt {
  readonly id: string;
  readonly expired: boolean;
  dispose(): Promise<void>;
}

export class LoginAttemptStore<T extends ExpirableAttempt = LoginAttempt> {
  readonly #attempts = new Map<string, T>();

  add(attempt: T): void {
    this.sweep();
    this.#attempts.set(attempt.id, attempt);
  }

  get(id: string): T | undefined {
    this.sweep();
    return this.#attempts.get(id);
  }

  remove(id: string): void {
    this.#attempts.delete(id);
  }

  sweep(): void {
    for (const [id, attempt] of this.#attempts) {
      if (attempt.expired) {
        this.#attempts.delete(id);
        void attempt.dispose();
      }
    }
  }

  get size(): number {
    return this.#attempts.size;
  }
}
