import pg from "pg";

/**
 * `date` columns (OID 1082) are calendar dates with no time and no zone. node-pg
 * otherwise parses them into a JS Date at *local* midnight, so any later
 * `.toISOString()` shifts the day for anyone east of UTC — `2025-09-15` reads back
 * as `2025-09-14` in Singapore. Keeping the raw string preserves the date exactly.
 */
const DATE_OID = 1082;

let configured = false;

export function configurePgTypes(): void {
  if (configured) return;
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
  configured = true;
}
