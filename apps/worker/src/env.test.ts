import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = { DATABASE_URL: "postgres://localhost:5432/easycal" };

describe("loadEnv", () => {
  it("defaults the sync overlap to the 24 hours the architecture recommends", () => {
    expect(loadEnv(base).SYNC_OVERLAP_HOURS).toBe(24);
  });

  it("allows a zero overlap but rejects a negative one", () => {
    expect(loadEnv({ ...base, SYNC_OVERLAP_HOURS: "0" }).SYNC_OVERLAP_HOURS).toBe(0);
    expect(() => loadEnv({ ...base, SYNC_OVERLAP_HOURS: "-1" })).toThrow();
  });
});
