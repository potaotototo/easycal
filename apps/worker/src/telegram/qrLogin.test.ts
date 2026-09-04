import { describe, expect, it } from "vitest";
import {
  QrLoginAttempt,
  type QrLoginCapableClient,
  type QrLoginClientFactory,
} from "./qrLogin.js";

/**
 * QR sign-in is a state machine driven entirely by Telegram: the code rotates until
 * it is scanned, then the login either completes or asks for a 2FA password. These
 * drive that machine with a fake client — no network, no real account.
 */

const CREDENTIALS = { apiId: 1234, apiHash: "hash" };

interface FakeOptions {
  requiresPassword?: boolean;
  correctPassword?: string;
  failWith?: string;
  telegramUserId?: string;
}

/** Mimics GramJS: emits a code, waits to be "scanned", then optionally asks for 2FA. */
function fakeQrClient(options: FakeOptions = {}) {
  let scan: (() => void) | undefined;
  let disconnected = false;

  const factory: QrLoginClientFactory = async () => {
    const client: QrLoginCapableClient = {
      async signInUserWithQrCode(_credentials, params) {
        if (options.failWith) {
          const error = new Error(options.failWith);
          await params.onError(error);
          throw error;
        }

        await params.qrCode({
          token: Buffer.from("first-token"),
          expires: Math.floor(Date.now() / 1000) + 30,
        });

        // Wait until the test says the code was scanned.
        await new Promise<void>((resolve) => {
          scan = resolve;
        });

        if (options.requiresPassword && params.password) {
          const password = await params.password();
          if (options.correctPassword && password !== options.correctPassword) {
            throw new Error("PASSWORD_HASH_INVALID");
          }
        }
        return undefined;
      },
      async getMe() {
        return { id: options.telegramUserId ?? "424242" };
      },
      session: { save: () => "QR-SESSION-STRING" },
      async disconnect() {
        disconnected = true;
        return undefined;
      },
    };
    return client;
  };

  return {
    factory,
    scan: () => scan?.(),
    disconnected: () => disconnected,
  };
}

/** The attempt settles asynchronously; give the microtask queue a chance. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("QrLoginAttempt", () => {
  it("produces a tg://login url to render as a QR code", async () => {
    const fake = fakeQrClient();
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);

    await attempt.begin();

    expect(attempt.state).toBe("pending");
    expect(attempt.token?.loginUrl).toBe(
      `tg://login?token=${Buffer.from("first-token").toString("base64url")}`,
    );
    // The token is base64url, so it carries none of base64's URL-unsafe characters.
    // (Checked on the token alone — the "tg://" scheme legitimately contains "//".)
    const encoded = attempt.token!.loginUrl.split("token=")[1]!;
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Date.parse(attempt.token!.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("authenticates once the code is scanned", async () => {
    const fake = fakeQrClient({ telegramUserId: "700100200" });
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    expect(attempt.state).toBe("pending");
    fake.scan();
    await settle();

    expect(attempt.state).toBe("authenticated");
    expect(attempt.login?.telegramUserId).toBe("700100200");
    expect(attempt.login?.sessionString).toBe("QR-SESSION-STRING");
  });

  it("asks for the 2FA password after the scan, then completes", async () => {
    const fake = fakeQrClient({ requiresPassword: true, correctPassword: "hunter2" });
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    fake.scan();
    await settle();
    expect(attempt.state).toBe("password_required");

    await attempt.submitPassword("hunter2");
    await settle();
    expect(attempt.state).toBe("authenticated");
  });

  it("fails on a wrong 2FA password rather than issuing a session", async () => {
    const fake = fakeQrClient({ requiresPassword: true, correctPassword: "hunter2" });
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    fake.scan();
    await settle();
    await attempt.submitPassword("wrong");
    await settle();

    expect(attempt.state).toBe("failed");
    expect(attempt.login).toBeUndefined();
  });

  it("refuses a password Telegram never asked for", async () => {
    const fake = fakeQrClient();
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    await expect(attempt.submitPassword("unsolicited")).rejects.toThrow(/not asked/i);
  });

  it("surfaces a failure that happens before any code is shown", async () => {
    const fake = fakeQrClient({ failWith: "API_ID_INVALID" });
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);

    await expect(attempt.begin()).rejects.toThrow(/API_ID_INVALID/);
  });

  it("disconnects the client on dispose", async () => {
    const fake = fakeQrClient();
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    await attempt.dispose();
    expect(fake.disconnected()).toBe(true);
  });

  it("expires so abandoned codes cannot accumulate", async () => {
    const fake = fakeQrClient();
    const attempt = new QrLoginAttempt(CREDENTIALS, fake.factory);
    await attempt.begin();

    expect(attempt.expired).toBe(false);
    Object.defineProperty(attempt, "createdAt", { value: Date.now() - 11 * 60 * 1000 });
    expect(attempt.expired).toBe(true);
  });
});
