import { z } from "zod";

/** A blank value in .env means "not configured yet", not "configured as empty". */
const blankAsMissing = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

const optionalText = blankAsMissing(z.string().min(1).optional());
const optionalPositiveInt = blankAsMissing(z.coerce.number().int().positive().optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Required from Phase 1 onward (Telegram login); optional while only /health exists.
  TELEGRAM_API_ID: optionalPositiveInt,
  TELEGRAM_API_HASH: optionalText,
  SESSION_ENCRYPTION_KEY: optionalText,
  APP_SESSION_SECRET: optionalText,
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
