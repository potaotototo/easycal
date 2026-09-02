import cookie from "@fastify/cookie";
import { getPool } from "@easycal/db";
import Fastify, { type FastifyInstance } from "fastify";
import { buildContext, type AppContext } from "./context.js";
import type { Env } from "./env.js";
import { registerAuthRoutes } from "./routes/auth.js";
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

  await app.register(cookie);

  const appContext = context ?? buildContext(env);

  app.get("/health", async () => {
    await getPool().query("select 1");
    return { status: "ok" };
  });

  registerAuthRoutes(app, appContext);
  registerFolderRoutes(app, appContext);
  registerEventRoutes(app, appContext);
  registerSnapshotRoutes(app, appContext);
  registerPreferenceRoutes(app, appContext);

  return app;
}
