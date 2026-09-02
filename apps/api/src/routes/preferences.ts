import { EVENT_CATEGORIES } from "@easycal/contracts/event";
import { getOrCreatePreferences, savePreferences } from "@easycal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireUser } from "../auth.js";
import type { AppContext } from "../context.js";

const preferencesBody = z.object({
  interestCategories: z.array(z.enum(EVENT_CATEGORIES)).min(1),
  locationTerms: z.array(z.string().trim().min(1).max(80)).max(20),
}).strict();

export function registerPreferenceRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/preferences", { preHandler: requireUser(context) }, async (request, reply) => {
    const preferences = await getOrCreatePreferences(context.db, currentUser(request).id);
    return reply.send(preferences);
  });

  app.put("/v1/preferences", { preHandler: requireUser(context) }, async (request, reply) => {
    const parsed = preferencesBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_preferences", issues: parsed.error.issues });
    }
    const preferences = await savePreferences(context.db, currentUser(request).id, parsed.data);
    return reply.send(preferences);
  });
}
