import { createSnapshot, findSnapshotByToken, listSnapshots, revokeSnapshot } from "@easycal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireUser } from "../auth.js";
import type { AppContext } from "../context.js";

const createBody = z.object({
  title: z.string().min(1).max(200),
  eventIds: z.array(z.string().uuid()).min(1).max(500),
});

export function registerSnapshotRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/share-snapshots", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const snapshot = await createSnapshot(
      context.db,
      user.id,
      parsed.data.title,
      parsed.data.eventIds,
    );

    return reply.code(201).send({
      id: snapshot.id,
      title: snapshot.title,
      eventCount: snapshot.eventCount,
      // Shown once. Only a hash is stored, so this cannot be recovered later.
      url: `/s/${snapshot.token}`,
      token: snapshot.token,
    });
  });

  app.get("/v1/share-snapshots", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    return reply.send({ snapshots: await listSnapshots(context.db, user.id) });
  });

  app.delete(
    "/v1/share-snapshots/:id",
    { preHandler: requireUser(context) },
    async (request, reply) => {
      const user = currentUser(request);
      const { id } = request.params as { id: string };
      const revoked = await revokeSnapshot(context.db, user.id, id);
      if (!revoked) return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true, revoked: true });
    },
  );

  /**
   * Public, unauthenticated, read-only. Serves the payloads copied at creation time
   * and never reads through to the owner's live events, so a revoked or edited
   * calendar cannot leak here. `noindex` keeps shared links out of search engines.
   */
  app.get("/s/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const snapshot = await findSnapshotByToken(context.db, token);
    if (!snapshot) return reply.code(404).send({ error: "not_found" });

    return reply
      .header("x-robots-tag", "noindex, nofollow")
      .header("cache-control", "no-store")
      .send(snapshot);
  });
}
