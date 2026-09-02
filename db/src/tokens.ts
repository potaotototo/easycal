import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer tokens for app sessions and public share links. The plaintext token is
 * shown once and never stored; only its SHA-256 hash goes in the database, so a
 * database leak does not hand out working links.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
