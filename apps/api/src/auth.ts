import { findUserById, findUserIdBySessionToken, type UserRow } from "@easycal/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";

export const SESSION_COOKIE = "easycal_session";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
    sessionToken?: string;
  }
}

/** Accepts the session cookie the web app uses, or a bearer token for API clients. */
export function readSessionToken(request: FastifyRequest): string | null {
  const cookie = request.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;

  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);

  return null;
}

/**
 * Attached to every private route. Resolving the session here means no handler can
 * forget to; repositories additionally scope each query by user id.
 */
export function requireUser(context: AppContext) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readSessionToken(request);
    if (!token) {
      await reply.code(401).send({ error: "not_authenticated" });
      return;
    }

    const userId = await findUserIdBySessionToken(context.db, token);
    if (!userId) {
      await reply.code(401).send({ error: "session_invalid" });
      return;
    }

    const user = await findUserById(context.db, userId);
    if (!user) {
      await reply.code(401).send({ error: "session_invalid" });
      return;
    }

    request.user = user;
    request.sessionToken = token;
  };
}

/** Narrows the optional `request.user` after `requireUser` has run. */
export function currentUser(request: FastifyRequest): UserRow {
  if (!request.user) throw new Error("requireUser did not run for this route");
  return request.user;
}
