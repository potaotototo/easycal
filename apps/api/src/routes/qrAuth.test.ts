import { EnvKeyProvider, encryptOnly } from "@easycal/db";
import { startTestDatabase, type TestDatabase } from "@easycal/db/testing";
import { LoginAttemptStore } from "@easycal/worker/telegram/login";
import type { QrLoginAttempt } from "@easycal/worker/telegram/qrLogin";
import type {
  QrLoginCapableClient,
  QrLoginClientFactory,
} from "@easycal/worker/telegram/qrLogin";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { buildServer } from "../server.js";

const KEY = Buffer.alloc(32, 6).toString("base64");

let database: TestDatabase;
let app: FastifyInstance;
let requiresPassword = false;
let scan: (() => void) | undefined;

function fakeQrFactory(): QrLoginClientFactory {
  return async () => {
    const client: QrLoginCapableClient = {
      async signInUserWithQrCode(_credentials, params) {
        await params.qrCode({
          token: Buffer.from("scan-me"),
          expires: Math.floor(Date.now() / 1000) + 30,
        });
        await new Promise<void>((resolve) => {
          scan = resolve;
        });
        if (requiresPassword && params.password) await params.password();
        return undefined;
      },
      async getMe() {
        return { id: "515151" };
      },
      session: { save: () => "QR-SECRET-SESSION" },
      async disconnect() {
        return undefined;
      },
    };
    return client;
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeAll(async () => {
  database = await startTestDatabase();

  const context: AppContext = {
    db: database.pool,
    keys: encryptOnly(new EnvKeyProvider(KEY)),
    telegram: { apiId: 1234, apiHash: "hash" },
    loginAttempts: new LoginAttemptStore(),
    qrLoginAttempts: new LoginAttemptStore<QrLoginAttempt>(),
    createQrLoginClient: fakeQrFactory(),
    cacheFolders: async () => {},
  };

  app = await buildServer(
    loadEnv({ DATABASE_URL: database.connectionString, LOG_LEVEL: "fatal" }),
    context,
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await database?.stop();
});

async function startQr() {
  return app.inject({
    method: "POST",
    url: "/v1/auth/telegram/qr",
    payload: { deviceTimezone: "Asia/Singapore" },
  });
}

describe("POST /v1/auth/telegram/qr", () => {
  it("returns a scannable code and a rendered QR image", async () => {
    requiresPassword = false;
    const response = await startQr();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.state).toBe("pending");
    expect(body.loginUrl).toMatch(/^tg:\/\/login\?token=/);
    // Rendered server-side, so the web app needs no QR dependency.
    expect(body.qrImage).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    // No session material may appear before the code is scanned.
    expect(response.body).not.toContain("QR-SECRET-SESSION");
  });
});

describe("GET /v1/auth/telegram/qr/:attemptId", () => {
  it("keeps returning the code while waiting to be scanned", async () => {
    requiresPassword = false;
    const { attemptId } = (await startQr()).json();

    const poll = await app.inject({ method: "GET", url: `/v1/auth/telegram/qr/${attemptId}` });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().state).toBe("pending");
    expect(poll.json().loginUrl).toMatch(/^tg:\/\/login\?token=/);
  });

  it("issues a session once the code is scanned", async () => {
    requiresPassword = false;
    const { attemptId } = (await startQr()).json();

    scan?.();
    await settle();

    const poll = await app.inject({ method: "GET", url: `/v1/auth/telegram/qr/${attemptId}` });
    expect(poll.statusCode).toBe(200);

    const body = poll.json();
    expect(body.state).toBe("authenticated");
    expect(body.sessionToken).toBeTruthy();
    expect(body.user.deviceTimezone).toBe("Asia/Singapore");
    expect(String(poll.headers["set-cookie"])).toContain("easycal_session=");
    // The Telegram session itself must never reach the browser.
    expect(poll.body).not.toContain("QR-SECRET-SESSION");
  });

  it("stores the Telegram session encrypted", async () => {
    const { rows } = await database.pool.query(
      "select encrypted_session from telegram_connections order by created_at desc limit 1",
    );
    const stored = rows[0].encrypted_session as Buffer;
    expect(stored.toString("utf8")).not.toContain("QR-SECRET-SESSION");
    expect(await new EnvKeyProvider(KEY).decrypt(stored)).toBe("QR-SECRET-SESSION");
  });

  it("the issued session works on a private route", async () => {
    requiresPassword = false;
    const { attemptId } = (await startQr()).json();
    scan?.();
    await settle();

    const { sessionToken } = (
      await app.inject({ method: "GET", url: `/v1/auth/telegram/qr/${attemptId}` })
    ).json();

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().connection.status).toBe("active");
  });

  it("410s an unknown attempt", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/telegram/qr/11111111-1111-1111-1111-111111111111",
    });
    expect(response.statusCode).toBe(410);
  });
});

describe("two-factor accounts", () => {
  it("asks for the password after the scan, then authenticates", async () => {
    requiresPassword = true;
    const { attemptId } = (await startQr()).json();

    scan?.();
    await settle();

    const waiting = await app.inject({
      method: "GET",
      url: `/v1/auth/telegram/qr/${attemptId}`,
    });
    expect(waiting.json().state).toBe("password_required");

    const submitted = await app.inject({
      method: "POST",
      url: `/v1/auth/telegram/qr/${attemptId}/password`,
      payload: { password: "hunter2" },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().state).toBe("authenticated");
    expect(submitted.json().sessionToken).toBeTruthy();
    requiresPassword = false;
  });

  it("rejects an empty password body", async () => {
    requiresPassword = false;
    const { attemptId } = (await startQr()).json();
    const response = await app.inject({
      method: "POST",
      url: `/v1/auth/telegram/qr/${attemptId}/password`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});
