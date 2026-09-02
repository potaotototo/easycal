export { getPool, closePool, withTransaction } from "./pool.js";
export type { Pool, PoolClient } from "./pool.js";
export type { Queryable } from "./types.js";

export { EnvKeyProvider, encryptOnly } from "./crypto.js";
export type { KeyProvider } from "./crypto.js";
export { generateToken, hashToken, tokensMatch } from "./tokens.js";
export { toPublicPayload } from "./publicPayload.js";

export * from "./repositories/users.js";
export * from "./repositories/sessions.js";
export * from "./repositories/connections.js";
export * from "./repositories/folders.js";
export * from "./repositories/chats.js";
export * from "./repositories/messages.js";
export * from "./repositories/syncRuns.js";
export * from "./repositories/events.js";
export * from "./repositories/snapshots.js";
export * from "./repositories/preferences.js";

// Test-only helper; imported by suites, never by the running services.
export { startTestDatabase, applyMigrations } from "./testing.js";
export type { TestDatabase } from "./testing.js";
