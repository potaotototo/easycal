import { isEventCategory, type EventCategory } from "@easycal/contracts/event";
import type { Queryable } from "../types.js";

export const DEFAULT_INTEREST_CATEGORIES: EventCategory[] = [
  "career",
  "internships",
  "technology",
  "entrepreneurship",
  "networking",
  "community",
];

export interface UserPreferences {
  interestCategories: EventCategory[];
  locationTerms: string[];
}

function validate(input: UserPreferences): UserPreferences {
  const interests = [...new Set(input.interestCategories)];
  if (interests.length === 0 || interests.some((item) => !isEventCategory(item))) {
    throw new Error("At least one valid interest category is required");
  }
  const seen = new Set<string>();
  const locations = input.locationTerms.flatMap((value) => {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || trimmed.length > 80 || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
  return { interestCategories: interests, locationTerms: locations };
}

export async function getOrCreatePreferences(
  db: Queryable,
  userId: string,
): Promise<UserPreferences> {
  await db.query(
    `insert into user_preferences (user_id, interest_categories)
     values ($1, $2::text[])
     on conflict (user_id) do nothing`,
    [userId, DEFAULT_INTEREST_CATEGORIES],
  );
  const { rows } = await db.query(
    `select interest_categories, location_terms from user_preferences where user_id = $1`,
    [userId],
  );
  return mapPreferences(rows[0]!);
}

export async function savePreferences(
  db: Queryable,
  userId: string,
  input: UserPreferences,
): Promise<UserPreferences> {
  const normalized = validate(input);
  const { rows } = await db.query(
    `insert into user_preferences (user_id, interest_categories, location_terms)
     values ($1, $2::text[], $3::text[])
     on conflict (user_id) do update
       set interest_categories = excluded.interest_categories,
           location_terms = excluded.location_terms,
           updated_at = now()
     returning interest_categories, location_terms`,
    [userId, normalized.interestCategories, normalized.locationTerms],
  );
  return mapPreferences(rows[0]!);
}

function mapPreferences(row: Record<string, unknown>): UserPreferences {
  return {
    interestCategories: row["interest_categories"] as EventCategory[],
    locationTerms: row["location_terms"] as string[],
  };
}
