import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { getPool } from "@easycal/db";
import Fastify, { type FastifyInstance } from "fastify";
import { buildContext, type AppContext } from "./context.js";
import type { Env } from "./env.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerQrAuthRoutes } from "./routes/qrAuth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerFolderRoutes } from "./routes/folders.js";
import { registerSnapshotRoutes } from "./routes/snapshots.js";
import { registerPreferenceRoutes } from "./routes/preferences.js";

export async function buildServer(env: Env, context?: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Telegram session material, bearer tokens and raw message text must never
      // reach the logs (docs/architecture.md, "Security requirements").
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "*.encryptedSession",
          "*.sessionString",
          "*.sessionToken",
          "*.token",
          "*.rawText",
          "*.normalizedText",
        ],
        remove: true,
      },
    },
  });

  // apps/web is served from a different origin (Cloudflare Workers), so the
  // browser needs explicit permission before it will send credentialed requests.
  await app.register(cors, {
    origin: env.WEB_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
  });

  await app.register(cookie);

  const appContext = context ?? buildContext(env);

  app.get("/health", async () => {
    await getPool().query("select 1");
    return { status: "ok" };
  });

  registerAuthRoutes(app, appContext);
  registerQrAuthRoutes(app, appContext);
  registerFolderRoutes(app, appContext);
  registerEventRoutes(app, appContext);
  registerSnapshotRoutes(app, appContext);
  registerPreferenceRoutes(app, appContext);

  return app;
}
