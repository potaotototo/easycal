import { z } from "zod";

/** A blank value in .env means "not configured yet", not "configured as empty". */
const blankAsMissing = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

const optionalText = blankAsMissing(z.string().min(1).optional());
const optionalPositiveInt = blankAsMissing(z.coerce.number().int().positive().optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Comma-separated browser origins allowed to call the API with credentials.
   * apps/web deploys to Cloudflare Workers, so it is always a different origin.
   */
  // A blank value means "not configured", not "allow nothing" — otherwise a
  // `WEB_ORIGINS=` line left in .env silently blocks every browser request.
  WEB_ORIGINS: blankAsMissing(
    z.string().default("http://localhost:3001,http://localhost:5173"),
  ).transform((value) =>
    String(value)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Required from Phase 1 onward (Telegram login); optional while only /health exists.
  TELEGRAM_API_ID: optionalPositiveInt,
  TELEGRAM_API_HASH: optionalText,
  SESSION_ENCRYPTION_KEY: optionalText,
  APP_SESSION_SECRET: optionalText,
});

export type Env = z.infer<typeof schema>;

/**
 * Secrets are optional in development so `pnpm test` and a bare `/health` check can
 * run without them. In production a missing one is a deployment mistake, and it is
 * far better to refuse to start than to fail on the first user's login.
 */
const REQUIRED_IN_PRODUCTION = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "SESSION_ENCRYPTION_KEY",
  "APP_SESSION_SECRET",
] as const;

function assertProductionConfig(env: Env, nodeEnv: string | undefined): void {
  if (nodeEnv !== "production") return;
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(", ")}. See .env.example.`,
    );
  }
  if (env.WEB_ORIGINS.length === 0) {
    throw new Error("WEB_ORIGINS must list the web app's origin in production.");
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment (see .env.example):\n${issues}`);
  }
  assertProductionConfig(parsed.data, source["NODE_ENV"]);
  return parsed.data;
}
