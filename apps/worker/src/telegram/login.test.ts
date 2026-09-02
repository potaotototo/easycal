import { describe, expect, it } from "vitest";
import {
  LoginAttempt,
  LoginAttemptStore,
  type LoginCapableClient,
  type LoginClientFactory,
} from "./login.js";

/**
 * Drives the two-request login state machine with a fake client. Telegram sign-in is
 * callback-driven inside one `start()` call, but our API splits it across
 * `POST /start` and `POST /verify`, and that bridge is easy to get subtly wrong.
 */

const CREDENTIALS = { apiId: 1234, apiHash: "hash" };

interface FakeOptions {
  requiresPassword?: boolean;
  correctCode?: string;
  correctPassword?: string;
  telegramUserId?: string;
}

/** Mimics GramJS: awaits the phoneCode callback, then optionally the password one. */
function fakeClientFactory(options: FakeOptions = {}): {
  factory: LoginClientFactory;
  disconnected: () => boolean;
} {
  let disconnected = false;

  const factory: LoginClientFactory = async () => {
    const client: LoginCapableClient = {
      async start(params) {
        const code = await params.phoneCode();
        if (options.correctCode && code !== options.correctCode) {
          throw new Error("PHONE_CODE_INVALID");
        }
        if (options.requiresPassword) {
          const password = await params.password();
          if (options.correctPassword && password !== options.correctPassword) {
            throw new Error("PASSWORD_HASH_INVALID");
          }
        }
        return undefined;
      },
      async getMe() {
        return { id: options.telegramUserId ?? "555000111" };
      },
      session: { save: () => "SESSION-STRING-DO-NOT-LOG" },
      async disconnect() {
        disconnected = true;
        return undefined;
      },
    };
    return client;
  };

  return { factory, disconnected: () => disconnected };
}

describe("LoginAttempt without 2FA", () => {
  it("resolves begin() only once Telegram has asked for the code", async () => {
    const { factory } = fakeClientFactory();
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);

    await attempt.begin();

    // begin() returning means there is genuinely a code to type in.
    expect(attempt.passwordRequested).toBe(false);
    expect(attempt.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("completes with the telegram user id and session string", async () => {
    const { factory } = fakeClientFactory({ telegramUserId: "700100200" });
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();

    const outcome = await attempt.complete("12345");

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("expected completion");
    expect(outcome.login.telegramUserId).toBe("700100200");
    expect(outcome.login.sessionString).toBe("SESSION-STRING-DO-NOT-LOG");
  });

  it("rejects a wrong code rather than issuing a session", async () => {
    const { factory } = fakeClientFactory({ correctCode: "12345" });
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();

    await expect(attempt.complete("00000")).rejects.toThrow(/PHONE_CODE_INVALID/);
  });
});

describe("LoginAttempt with 2FA", () => {
  it("asks for a password instead of completing, when one is required", async () => {
    const { factory } = fakeClientFactory({ requiresPassword: true });
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();

    const outcome = await attempt.complete("12345");

    // This is what makes the API answer 409 password_required.
    expect(outcome.done).toBe(false);
    expect(attempt.passwordRequested).toBe(true);
  });

  it("completes on the retry that supplies the password", async () => {
    const { factory } = fakeClientFactory({
      requiresPassword: true,
      correctPassword: "hunter2",
    });
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();

    expect((await attempt.complete("12345")).done).toBe(false);

    const outcome = await attempt.complete("12345", "hunter2");
    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("expected completion");
    expect(outcome.login.sessionString).toBe("SESSION-STRING-DO-NOT-LOG");
  });

  it("rejects a wrong password", async () => {
    const { factory } = fakeClientFactory({
      requiresPassword: true,
      correctPassword: "hunter2",
    });
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();
    await attempt.complete("12345");

    await expect(attempt.complete("12345", "wrong")).rejects.toThrow(/PASSWORD_HASH_INVALID/);
  });
});

describe("disposal", () => {
  it("disconnects the underlying client", async () => {
    const { factory, disconnected } = fakeClientFactory();
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();

    await attempt.dispose();
    expect(disconnected()).toBe(true);
  });
});

describe("LoginAttemptStore", () => {
  it("stores and retrieves an attempt by id", async () => {
    const store = new LoginAttemptStore();
    const { factory } = fakeClientFactory();
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);

    store.add(attempt);
    expect(store.get(attempt.id)).toBe(attempt);
    expect(store.size).toBe(1);

    store.remove(attempt.id);
    expect(store.get(attempt.id)).toBeUndefined();
  });

  it("sweeps expired attempts so abandoned logins cannot pile up", async () => {
    const store = new LoginAttemptStore();
    const { factory } = fakeClientFactory();
    const attempt = new LoginAttempt(CREDENTIALS, "+6591234567", factory);
    await attempt.begin();
    store.add(attempt);

    // Age the attempt past its 5-minute TTL.
    Object.defineProperty(attempt, "createdAt", { value: Date.now() - 6 * 60 * 1000 });
    expect(attempt.expired).toBe(true);

    store.sweep();
    expect(store.get(attempt.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
