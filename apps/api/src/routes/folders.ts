import {
  countRecentRuns,
  createSyncRun,
  findActiveConnectionByUser,
  findFolderSelection,
  listCachedFolders,
  saveFolderSelection,
} from "@easycal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireUser } from "../auth.js";
import type { AppContext } from "../context.js";

const selectionBody = z.object({
  telegramFolderId: z.number().int(),
  folderTitle: z.string().min(1),
  lookbackDays: z.number().int().min(1).max(90).default(7),
});

/** One on-demand sync per connection per minute. */
const SYNC_RATE_WINDOW_SECONDS = 60;
const SYNC_RATE_LIMIT = 1;

export function registerFolderRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/folders", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const connection = await findActiveConnectionByUser(context.db, user.id);
    if (!connection) return reply.code(409).send({ error: "no_telegram_connection" });

    const [folders, selection] = await Promise.all([
      listCachedFolders(context.db, connection.id),
      findFolderSelection(context.db, connection.id),
    ]);

    return reply.send({
      folders,
      selected: selection
        ? {
            telegramFolderId: selection.telegramFolderId,
            folderTitle: selection.folderTitle,
            lookbackDays: selection.lookbackDays,
          }
        : null,
    });
  });

  app.put("/v1/folder-selection", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = selectionBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const connection = await findActiveConnectionByUser(context.db, user.id);
    if (!connection) return reply.code(409).send({ error: "no_telegram_connection" });

    await saveFolderSelection(context.db, {
      connectionId: connection.id,
      telegramFolderId: parsed.data.telegramFolderId,
      folderTitle: parsed.data.folderTitle,
      lookbackDays: parsed.data.lookbackDays,
    });

    return reply.send({ ok: true, selection: parsed.data });
  });

  app.post("/v1/sync-runs", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const connection = await findActiveConnectionByUser(context.db, user.id);
    if (!connection) return reply.code(409).send({ error: "no_telegram_connection" });

    const recent = await countRecentRuns(context.db, connection.id, SYNC_RATE_WINDOW_SECONDS);
    if (recent >= SYNC_RATE_LIMIT) {
      return reply
        .code(429)
        .header("retry-after", String(SYNC_RATE_WINDOW_SECONDS))
        .send({ error: "sync_rate_limited" });
    }

    // The worker picks queued runs up; the API never talks to Telegram for sync.
    const runId = await createSyncRun(context.db, connection.id);
    return reply.code(202).send({ runId, status: "queued" });
  });
}
