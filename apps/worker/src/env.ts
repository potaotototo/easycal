import { z } from "zod";

/** A blank value in .env means "not configured yet", not "configured as empty". */
const blankAsMissing = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

const optionalText = blankAsMissing(z.string().min(1).optional());
const optionalPositiveInt = blankAsMissing(z.coerce.number().int().positive().optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Extra hours re-fetched on top of lookback_days so edits and late replies land. */
  SYNC_OVERLAP_HOURS: z.coerce.number().int().min(0).default(24),
  // Required from Phase 2 onward, when the worker actually talks to Telegram.
  TELEGRAM_API_ID: optionalPositiveInt,
  TELEGRAM_API_HASH: optionalText,
  SESSION_ENCRYPTION_KEY: optionalText,
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment (see .env.example):\n${issues}`);
  }
  return parsed.data;
}
