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
