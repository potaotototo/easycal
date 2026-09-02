import {
  EnvKeyProvider,
  encryptOnly,
  startTestDatabase,
  type TestDatabase,
} from "@easycal/db";
import { LoginAttemptStore } from "@easycal/worker/telegram/login";
import type { LoginCapableClient, LoginClientFactory } from "@easycal/worker/telegram/login";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { buildServer } from "../server.js";

/**
 * The Telegram account IS the app identity, so these two requests are both the
 * signup and the login. Exercised with a fake Telegram client — no network, no
 * real account — via the seams on AppContext.
 */

const KEY = Buffer.alloc(32, 8).toString("base64");

let database: TestDatabase;
let app: FastifyInstance;
let requiresPassword = false;
let cachedFoldersFor: string[] = [];

function fakeLoginClientFactory(): LoginClientFactory {
  return async () => {
    const client: LoginCapableClient = {
      async start(params) {
        await params.phoneCode();
        if (requiresPassword) await params.password();
        return undefined;
      },
      async getMe() {
        return { id: "424242" };
      },
      session: { save: () => "SECRET-SESSION-STRING" },
      async disconnect() {
        return undefined;
      },
    };
    return client;
  };
}

beforeAll(async () => {
  database = await startTestDatabase();

  const context: AppContext = {
    db: database.pool,
    keys: encryptOnly(new EnvKeyProvider(KEY)),
    telegram: { apiId: 1234, apiHash: "hash" },
    loginAttempts: new LoginAttemptStore(),
    createLoginClient: fakeLoginClientFactory(),
    cacheFolders: async (connectionId) => {
      cachedFoldersFor.push(connectionId);
    },
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

async function startLogin(phone = "+6591234567") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/telegram/start",
    payload: { phone, deviceTimezone: "Asia/Singapore" },
  });
  return response;
}

describe("POST /v1/auth/telegram/start", () => {
  it("returns an attempt id and never any session material", async () => {
    const response = await startLogin();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.codeSent).toBe(true);
    expect(response.body).not.toContain("SECRET-SESSION-STRING");
  });

  it("rejects a malformed phone number", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/start",
      payload: { phone: "x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /v1/auth/telegram/verify", () => {
  it("creates the user, stores the connection, and issues a session", async () => {
    requiresPassword = false;
    cachedFoldersFor = [];
    const { attemptId } = (await startLogin()).json();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/verify",
      payload: { attemptId, code: "12345" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.deviceTimezone).toBe("Asia/Singapore");
    expect(body.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sessionToken).toBeTruthy();

    // The session cookie is set httpOnly.
    const cookie = response.headers["set-cookie"];
    expect(String(cookie)).toContain("easycal_session=");
    expect(String(cookie)).toContain("HttpOnly");

    // Telegram session material must never appear in the response.
    expect(response.body).not.toContain("SECRET-SESSION-STRING");

    // Folders are cached while a live client is still in hand.
    expect(cachedFoldersFor).toEqual([body.connectionId]);
  });

  it("stores the Telegram session encrypted, not in plaintext", async () => {
    const { rows } = await database.pool.query(
      "select encrypted_session from telegram_connections order by created_at desc limit 1",
    );
    const stored = rows[0].encrypted_session as Buffer;
    expect(stored.toString("utf8")).not.toContain("SECRET-SESSION-STRING");
    // Only the worker holds a provider that can read it back.
    expect(await new EnvKeyProvider(KEY).decrypt(stored)).toBe("SECRET-SESSION-STRING");
  });

  it("returns the same user on a second login from the same Telegram account", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await freshSession()}` },
    });
    const firstId = first.json().user.id;

    const second = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await freshSession()}` },
    });
    expect(second.json().user.id).toBe(firstId);
  });

  it("asks for the 2FA password with 409, then completes on retry", async () => {
    requiresPassword = true;
    const { attemptId } = (await startLogin()).json();

    const needsPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/verify",
      payload: { attemptId, code: "12345" },
    });
    expect(needsPassword.statusCode).toBe(409);
    expect(needsPassword.json()).toEqual({ error: "password_required" });

    const completed = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/verify",
      payload: { attemptId, code: "12345", password: "hunter2" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().sessionToken).toBeTruthy();
    requiresPassword = false;
  });

  it("410s an unknown or expired attempt", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/telegram/verify",
      payload: { attemptId: "11111111-1111-1111-1111-111111111111", code: "12345" },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: "attempt_expired" });
  });
});

describe("session lifecycle", () => {
  it("reports the connection status on /v1/me", async () => {
    const token = await freshSession();
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connection.status).toBe("active");
  });

  it("logout revokes the session immediately", async () => {
    const token = await freshSession();
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/v1/me", headers });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "session_invalid" });
  });
});

/** Completes a login and returns a usable session token. */
async function freshSession(): Promise<string> {
  requiresPassword = false;
  const { attemptId } = (await startLogin()).json();
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/telegram/verify",
    payload: { attemptId, code: "12345" },
  });
  return verified.json().sessionToken as string;
}
