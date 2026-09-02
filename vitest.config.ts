import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Person B owns packages/event-parser and apps/web and runs their own suites.
    include: ["apps/api/**/*.test.ts", "apps/worker/**/*.test.ts", "db/src/**/*.test.ts"],
    environment: "node",
    // The acceptance test starts a throwaway Postgres, which takes a few seconds.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
