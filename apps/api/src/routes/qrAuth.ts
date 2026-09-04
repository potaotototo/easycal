import { issueSession, replaceConnection, upsertUserByTelegramId } from "@easycal/db";
import { QrLoginAttempt } from "@easycal/worker/telegram/qrLogin";
import type { FastifyInstance, FastifyReply } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth.js";
import type { AppContext } from "../context.js";
import { cacheFoldersForConnection } from "./auth.js";

/**
 * QR sign-in, mirroring Telegram Web: show a code, the person scans it from a device
 * that is already signed in, and the session is authorized.
 *
 * Unlike the phone flow this is a poll, because Telegram rotates the code every ~30
 * seconds until it is scanned and there is nothing for the browser to submit in the
 * meantime.
 */

const passwordBody = z.object({ password: z.string().min(1) });
const deviceTimezones = new Map<string, string | undefined>();

/** Rendered server-side so the web app needs no QR dependency of its own. */
async function renderQr(loginUrl: string): Promise<string> {
  const svg = await QRCode.toString(loginUrl, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function registerQrAuthRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/auth/telegram/qr", async (request, reply) => {
    if (!context.telegram) {
      return reply.code(503).send({ error: "telegram_not_configured" });
    }

    const body = z
      .object({ deviceTimezone: z.string().min(1).optional() })
      .safeParse(request.body ?? {});

    const attempt = new QrLoginAttempt(context.telegram, context.createQrLoginClient);
    try {
      await attempt.begin();
    } catch (error) {
      await attempt.dispose();
      request.log.warn({ err: error }, "qr login could not start");
      return reply.code(502).send({ error: "telegram_login_failed" });
    }

    context.qrLoginAttempts.add(attempt);
    deviceTimezones.set(attempt.id, body.success ? body.data.deviceTimezone : undefined);

    const token = attempt.token;
    return reply.send({
      attemptId: attempt.id,
      state: attempt.state,
      loginUrl: token?.loginUrl ?? null,
      expiresAt: token?.expiresAt ?? null,
      qrImage: token ? await renderQr(token.loginUrl) : null,
    });
  });

  /**
   * Polled by the login page. Returns the current code while waiting, asks for the
   * 2FA password when Telegram does, and issues the session once authorized.
   */
  app.get("/v1/auth/telegram/qr/:attemptId", async (request, reply) => {
    const { attemptId } = request.params as { attemptId: string };
    const attempt = context.qrLoginAttempts.get(attemptId);
    if (!attempt) return reply.code(410).send({ error: "attempt_expired" });

    if (attempt.state === "failed") {
      context.qrLoginAttempts.remove(attempt.id);
      await attempt.dispose();
      return reply.code(401).send({ error: "telegram_sign_in_failed" });
    }

    if (attempt.state === "authenticated") {
      return completeLogin(context, attempt, reply, request.log);
    }

    if (attempt.state === "password_required") {
      return reply.send({ state: "password_required" });
    }

    const token = attempt.token;
    return reply.send({
      state: "pending",
      loginUrl: token?.loginUrl ?? null,
      expiresAt: token?.expiresAt ?? null,
      qrImage: token ? await renderQr(token.loginUrl) : null,
    });
  });

  app.post("/v1/auth/telegram/qr/:attemptId/password", async (request, reply) => {
    const { attemptId } = request.params as { attemptId: string };
    const attempt = context.qrLoginAttempts.get(attemptId);
    if (!attempt) return reply.code(410).send({ error: "attempt_expired" });

    const parsed = passwordBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      await attempt.submitPassword(parsed.data.password);
    } catch (error) {
      request.log.warn({ err: error }, "qr password submission failed");
      return reply.code(409).send({ error: "password_not_requested" });
    }

    if (attempt.state === "failed") {
      context.qrLoginAttempts.remove(attempt.id);
      await attempt.dispose();
      return reply.code(401).send({ error: "telegram_sign_in_failed" });
    }

    if (attempt.state !== "authenticated") {
      // Still settling; the poller will pick it up.
      return reply.send({ state: attempt.state });
    }

    return completeLogin(context, attempt, reply, request.log);
  });
}

/** Shared tail of the flow: store the connection and issue the app session. */
async function completeLogin(
  context: AppContext,
  attempt: QrLoginAttempt,
  reply: FastifyReply,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<FastifyReply> {
  const login = attempt.login;
  if (!login) return reply.code(500).send({ error: "login_incomplete" });

  const deviceTimezone = deviceTimezones.get(attempt.id);
  deviceTimezones.delete(attempt.id);

  const user = await upsertUserByTelegramId(context.db, login.telegramUserId, deviceTimezone);
  const connection = await replaceConnection(
    context.db,
    context.keys,
    user.id,
    login.sessionString,
  );

  // The API cannot decrypt this session later, so cache folders while a live
  // authenticated client is still in hand.
  const cache =
    context.cacheFolders ??
    ((id: string, session: string) => cacheFoldersForConnection(context, id, session));
  await cache(connection.id, login.sessionString).catch((error: unknown) => {
    log.warn({ err: error }, "could not cache folders after qr login");
  });

  context.qrLoginAttempts.remove(attempt.id);
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
      state: "authenticated",
      user: { id: user.id, deviceTimezone: user.deviceTimezone },
      connectionId: connection.id,
      sessionToken: session.token,
    });
}
