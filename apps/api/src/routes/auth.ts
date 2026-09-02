import {
  findActiveConnectionByUser,
  replaceConnection,
  issueSession,
  revokeSession,
  saveFolderCache,
  upsertUserByTelegramId,
} from "@easycal/db";
import { createClient } from "@easycal/worker/telegram/gramjs";
import { GramJsTelegramPort } from "@easycal/worker/telegram/gramjs";
import { LoginAttempt } from "@easycal/worker/telegram/login";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireUser, SESSION_COOKIE } from "../auth.js";
import type { AppContext } from "../context.js";

const startBody = z.object({
  phone: z.string().min(5),
  deviceTimezone: z.string().min(1).optional(),
});

const verifyBody = z.object({
  attemptId: z.string().uuid(),
  code: z.string().min(1),
  password: z.string().min(1).optional(),
});

/**
 * The Telegram account is the app identity: there is no separate signup. The
 * MTProto login is multi-step, so it is modelled as a short-lived attempt held in
 * memory between the two requests (see apps/api/README.md for the single-instance
 * constraint this implies).
 */
export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/auth/telegram/start", async (request, reply) => {
    if (!context.telegram) {
      return reply.code(503).send({ error: "telegram_not_configured" });
    }

    const parsed = startBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const attempt = new LoginAttempt(
      context.telegram,
      parsed.data.phone,
      context.createLoginClient,
    );
    try {
      await attempt.begin();
    } catch (error) {
      await attempt.dispose();
      request.log.warn({ err: error }, "telegram login could not start");
      return reply.code(502).send({ error: "telegram_login_failed" });
    }

    context.loginAttempts.add(attempt);
    // Carry the timezone to the verify step; it is only known by the browser.
    deviceTimezones.set(attempt.id, parsed.data.deviceTimezone);

    return reply.send({ attemptId: attempt.id, codeSent: true });
  });

  app.post("/v1/auth/telegram/verify", async (request, reply) => {
    const parsed = verifyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const attempt = context.loginAttempts.get(parsed.data.attemptId);
    if (!attempt) return reply.code(410).send({ error: "attempt_expired" });

    let outcome;
    try {
      outcome = await attempt.complete(parsed.data.code, parsed.data.password);
    } catch (error) {
      context.loginAttempts.remove(attempt.id);
      await attempt.dispose();
      request.log.warn({ err: error }, "telegram sign-in failed");
      return reply.code(401).send({ error: "telegram_sign_in_failed" });
    }

    if (!outcome.done) {
      // 2FA is on: the caller must retry with the account password.
      return reply.code(409).send({ error: "password_required" });
    }

    const { telegramUserId, sessionString } = outcome.login;
    const deviceTimezone = deviceTimezones.get(attempt.id);
    deviceTimezones.delete(attempt.id);

    const user = await upsertUserByTelegramId(context.db, telegramUserId, deviceTimezone);
    const connection = await replaceConnection(
      context.db,
      context.keys,
      user.id,
      sessionString,
    );

    // The API cannot decrypt this session later, so cache the folder list now,
    // while a live authenticated client is still in hand.
    const cache = context.cacheFolders ?? ((id, session) => cacheFolders(context, id, session));
    await cache(connection.id, sessionString).catch((error: unknown) => {
      request.log.warn({ err: error }, "could not cache folders after login");
    });

    context.loginAttempts.remove(attempt.id);
    await attempt.dispose();

    const session = await issueSession(context.db, user.id);
    return reply
      .setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        expires: session.expiresAt,
      })
      .send({
        user: { id: user.id, deviceTimezone: user.deviceTimezone },
        connectionId: connection.id,
        // Returned for non-browser clients; browsers use the cookie.
        sessionToken: session.token,
      });
  });

  app.post(
    "/v1/auth/logout",
    { preHandler: requireUser(context) },
    async (request, reply) => {
      if (request.sessionToken) await revokeSession(context.db, request.sessionToken);
      return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
    },
  );

  app.get("/v1/me", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const connection = await findActiveConnectionByUser(context.db, user.id);
    return reply.send({
      user: { id: user.id, deviceTimezone: user.deviceTimezone },
      connection: connection ? { id: connection.id, status: connection.status } : null,
    });
  });
}

/** Timezone is supplied at /start but only needed at /verify. */
const deviceTimezones = new Map<string, string | undefined>();

async function cacheFolders(
  context: AppContext,
  connectionId: string,
  sessionString: string,
): Promise<void> {
  if (!context.telegram) return;
  const client = await createClient(context.telegram, sessionString);
  try {
    const folders = await new GramJsTelegramPort(client).listFolders();
    await saveFolderCache(
      context.db,
      connectionId,
      folders.map((folder) => ({ telegramFolderId: folder.id, title: folder.title })),
    );
  } finally {
    await client.disconnect();
  }
}
