import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The seam between v1's env-held key and a managed KMS. Only the sync worker is
 * ever given a provider that can `decrypt` (docs/architecture.md); the API is
 * handed an encrypt-only view during Telegram onboarding.
 */
export interface KeyProvider {
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<string>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM with a key supplied by the environment. Output layout is
 * `iv || authTag || ciphertext`, stored directly in a bytea column.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) {
      throw new Error(
        `SESSION_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.#key = key;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async decrypt(payload: Buffer): Promise<string> {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new Error("Encrypted payload is truncated");
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

/** An encrypt-only view, so the API cannot read back session material it stored. */
export function encryptOnly(provider: KeyProvider): Pick<KeyProvider, "encrypt"> {
  return { encrypt: (plaintext) => provider.encrypt(plaintext) };
}
