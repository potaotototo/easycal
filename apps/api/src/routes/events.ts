import {
  confirmById,
  correctById,
  dismissById,
  findViewById,
  listEventViews,
  type EventCorrection,
} from "@easycal/db";
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

const correctionFields = z.object({
  title: z.string().min(1).optional(),
  eventDate: isoDate.optional(),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  allDay: z.boolean().optional(),
  locationName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  rsvpUrl: z.string().url().nullable().optional(),
});

/**
 * PATCH accepts two vocabularies on purpose.
 *
 * apps/web sends `{ status }` and `{ correction }`; the original API contract in
 * docs/architecture.md used `{ action }`. Rather than force one side to change and
 * break the other, both are accepted and normalized here.
 */
const patchBody = z.union([
  z.object({ status: z.enum(["confirmed", "dismissed"]) }),
  z.object({ correction: correctionFields }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("confirm") }),
  correctionFields.extend({ action: z.literal("correct") }),
]);

type PatchIntent =
  | { kind: "dismiss" }
  | { kind: "confirm" }
  | { kind: "correct"; correction: EventCorrection };

function toIntent(body: z.infer<typeof patchBody>): PatchIntent {
  if ("status" in body) {
    return body.status === "dismissed" ? { kind: "dismiss" } : { kind: "confirm" };
  }
  if ("correction" in body) return { kind: "correct", correction: body.correction };
  if (body.action === "dismiss") return { kind: "dismiss" };
  if (body.action === "confirm") return { kind: "confirm" };

  const { action: _action, ...correction } = body;
  return { kind: "correct", correction };
}

export function registerEventRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/events", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = eventQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    }

    const events = await listEventViews(context.db, user.id, {
      ...parsed.data,
      query: parsed.data.q,
    });
    return reply.send({ events });
  });

  app.get("/v1/events.ics", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const parsed = eventQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    const events = await listEventViews(context.db, user.id, {
      ...parsed.data,
      query: parsed.data.q,
    });

    // Only confirmed events belong in a calendar file.
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", 'attachment; filename="easycal.ics"')
      .send(buildIcs(events.filter((event) => event.status === "confirmed"), {
        calendarName: "EasyCal",
      }));
  });

  app.get("/v1/events/:id", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const event = await findViewById(context.db, user.id, id);
    if (!event) return reply.code(404).send({ error: "not_found" });
    return reply.send(event);
  });

  app.patch("/v1/events/:id", { preHandler: requireUser(context) }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }

    const intent = toIntent(parsed.data);

    if (intent.kind === "dismiss") {
      const dismissed = await dismissById(context.db, user.id, id);
      if (!dismissed) return reply.code(404).send({ error: "not_found" });
      // 204 so the frontend's `response.status === 204` branch short-circuits.
      return reply.code(204).send();
    }

    const event =
      intent.kind === "confirm"
        ? await confirmById(context.db, user.id, id)
        : await correctById(context.db, user.id, id, intent.correction);
    if (!event) return reply.code(404).send({ error: "not_found" });
    // The frontend reads the event object directly, not wrapped in an envelope.
    return reply.send(event);
  });
}
