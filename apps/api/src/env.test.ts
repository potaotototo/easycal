import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = { DATABASE_URL: "postgres://localhost:5432/easycal" };

describe("loadEnv", () => {
  it("applies defaults when only the database URL is set", () => {
    const env = loadEnv(base);
    expect(env.API_PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing database URL rather than starting half-configured", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("coerces API_PORT from the string the shell provides", () => {
    expect(loadEnv({ ...base, API_PORT: "8080" }).API_PORT).toBe(8080);
  });
});

describe("optional Telegram settings", () => {
  it("treats a blank .env placeholder as not configured", () => {
    const env = loadEnv({ ...base, TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" });
    expect(env.TELEGRAM_API_ID).toBeUndefined();
    expect(env.TELEGRAM_API_HASH).toBeUndefined();
  });

  it("still parses a real value", () => {
    expect(loadEnv({ ...base, TELEGRAM_API_ID: "12345" }).TELEGRAM_API_ID).toBe(12345);
  });
});

describe("production configuration", () => {
  const production = { ...base, NODE_ENV: "production" };

  it("refuses to start without the secrets it needs", () => {
    expect(() => loadEnv(production)).toThrow(/Missing required production configuration/);
    expect(() => loadEnv(production)).toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it("starts when every secret is present", () => {
    const env = loadEnv({
      ...production,
      TELEGRAM_API_ID: "1234",
      TELEGRAM_API_HASH: "hash",
      SESSION_ENCRYPTION_KEY: "key",
      APP_SESSION_SECRET: "secret",
      WEB_ORIGINS: "https://easycal.example",
    });
    expect(env.WEB_ORIGINS).toEqual(["https://easycal.example"]);
  });

  it("still allows a bare development config", () => {
    expect(() => loadEnv(base)).not.toThrow();
  });
});

describe("WEB_ORIGINS", () => {
  it("treats a blank value as unset rather than an empty allowlist", () => {
    // A `WEB_ORIGINS=` line left in .env must not silently block every browser call.
    expect(loadEnv({ ...base, WEB_ORIGINS: "" }).WEB_ORIGINS).toEqual([
      "http://localhost:3001",
      "http://localhost:5173",
    ]);
  });

  it("splits and trims a configured list", () => {
    expect(
      loadEnv({ ...base, WEB_ORIGINS: "https://a.example, https://b.example" }).WEB_ORIGINS,
    ).toEqual(["https://a.example", "https://b.example"]);
  });
});
