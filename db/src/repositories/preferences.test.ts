import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../testing.js";
import {
  DEFAULT_INTEREST_CATEGORIES,
  getOrCreatePreferences,
  savePreferences,
} from "./preferences.js";

describe("user preference repository", () => {
  let database: TestDatabase;
  let userId: string;

  beforeAll(async () => {
    database = await startTestDatabase();
    userId = randomUUID();
    await database.pool.query(
      "insert into users (id, telegram_user_id, device_timezone) values ($1, $2, 'Asia/Singapore')",
      [userId, `telegram-${userId}`],
    );
  });

  afterAll(async () => database?.stop());

  it("creates stable defaults for a new user", async () => {
    await expect(getOrCreatePreferences(database.pool, userId)).resolves.toEqual({
      interestCategories: DEFAULT_INTEREST_CATEGORIES,
      locationTerms: [],
    });
    await expect(getOrCreatePreferences(database.pool, userId)).resolves.toEqual({
      interestCategories: DEFAULT_INTEREST_CATEGORIES,
      locationTerms: [],
    });
  });

  it("replaces preferences and normalizes location terms", async () => {
    await expect(savePreferences(database.pool, userId, {
      interestCategories: ["technology", "career"],
      locationTerms: [" NUS ", "nus", "Online"],
    })).resolves.toEqual({
      interestCategories: ["technology", "career"],
      locationTerms: ["NUS", "Online"],
    });
  });

  it("rejects empty or unsupported interests", async () => {
    await expect(savePreferences(database.pool, userId, {
      interestCategories: [],
      locationTerms: [],
    })).rejects.toThrow("interest category");
    await expect(savePreferences(database.pool, userId, {
      interestCategories: ["made_up" as "career"],
      locationTerms: [],
    })).rejects.toThrow("interest category");
  });
});
