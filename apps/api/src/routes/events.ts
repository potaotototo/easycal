import { correctEvent, dismissEvent, findEventById, listEvents } from "@easycal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireUser } from "../auth.js";
import type { AppContext } from "../context.js";
import { buildIcs } from "../ics.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const eventQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  sourceChatId: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const patchBody = z.union([
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("confirm") }),
  z.object({
    action: z.literal("correct"),
    title: z.string().min(1).optional(),
    locationName: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    rsvpUrl: z.string().url().nullable().optional(),
  }),
]);

export function registerEventRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/events", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = eventQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }

    const events = await listEvents(context.db, user.id, {
      ...parsed.data,
      query: parsed.data.q,
    });
    return reply.send({ events });
  });

  app.get("/v1/events.ics", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = eventQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    const events = await listEvents(context.db, user.id, {
      ...parsed.data,
      query: parsed.data.q,
    });

    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", 'attachment; filename="easycal.ics"')
      .send(buildIcs(events, { calendarName: "EasyCal" }));
  });

  app.get("/v1/events/:id", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const event = await findEventById(context.db, user.id, id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    return reply.send({ event });
  });

  app.patch("/v1/events/:id", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    if (parsed.data.action === "dismiss") {
      const dismissed = await dismissEvent(context.db, user.id, id);
      if (!dismissed) return reply.code(404).send({ error: "not_found" });
      return reply.send({ ok: true, status: "dismissed" });
    }

    if (parsed.data.action === "confirm") {
      const event = await findEventById(context.db, user.id, id);
      if (!event) return reply.code(404).send({ error: "not_found" });
      return reply.send({ event });
    }

    const { action: _action, ...patch } = parsed.data;
    const event = await correctEvent(context.db, user.id, id, patch);
    if (!event) return reply.code(404).send({ error: "not_found" });
    return reply.send({ event });
  });
}
