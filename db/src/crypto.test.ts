import { describe, expect, it } from "vitest";
import { EnvKeyProvider, encryptOnly } from "./crypto.js";

/**
 * Telegram session material is the most sensitive thing this system stores. Until
 * now only `encrypt` was exercised (via saveConnection); a broken `decrypt` would
 * have stayed invisible until the worker first tried to use a real session.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 4).toString("base64");
const SESSION = "1BQANOTEuMTA4LjU2LjEyOQG7fake-string-with-==-and-symbols";

describe("EnvKeyProvider", () => {
  it("round-trips a session string", async () => {
    const keys = new EnvKeyProvider(KEY);
    const encrypted = await keys.encrypt(SESSION);
    expect(await keys.decrypt(encrypted)).toBe(SESSION);
  });

  it("produces ciphertext that does not contain the plaintext", async () => {
    const keys = new EnvKeyProvider(KEY);
    const encrypted = await keys.encrypt(SESSION);
    expect(encrypted.toString("utf8")).not.toContain("fake-string");
    expect(encrypted.toString("base64")).not.toContain(SESSION);
  });

  it("uses a fresh IV, so the same input encrypts differently each time", async () => {
    const keys = new EnvKeyProvider(KEY);
    const a = await keys.encrypt(SESSION);
    const b = await keys.encrypt(SESSION);
    expect(a.equals(b)).toBe(false);
    expect(await keys.decrypt(a)).toBe(await keys.decrypt(b));
  });

  it("round-trips unicode and empty strings", async () => {
    const keys = new EnvKeyProvider(KEY);
    for (const value of ["", "日本語 🎉 emoji", "a".repeat(10_000)]) {
      expect(await keys.decrypt(await keys.encrypt(value))).toBe(value);
    }
  });

  it("refuses to decrypt with the wrong key", async () => {
    const encrypted = await new EnvKeyProvider(KEY).encrypt(SESSION);
    await expect(new EnvKeyProvider(OTHER_KEY).decrypt(encrypted)).rejects.toThrow();
  });

  it("detects tampering — GCM authentication must fail, not return garbage", async () => {
    const keys = new EnvKeyProvider(KEY);
    const encrypted = await keys.encrypt(SESSION);

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
    await expect(keys.decrypt(tampered)).rejects.toThrow();

    const tamperedTag = Buffer.from(encrypted);
    tamperedTag[13] ^= 0xff; // flip a bit in the auth tag
    await expect(keys.decrypt(tamperedTag)).rejects.toThrow();
  });

  it("rejects a truncated payload rather than throwing something unhelpful", async () => {
    const keys = new EnvKeyProvider(KEY);
    await expect(keys.decrypt(Buffer.alloc(4))).rejects.toThrow(/truncated/i);
  });

  it("rejects a key that is not 32 bytes, with a message saying how to make one", () => {
    expect(() => new EnvKeyProvider("c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => new EnvKeyProvider("c2hvcnQ=")).toThrow(/randomBytes\(32\)/);
  });
});

describe("encryptOnly", () => {
  it("exposes encrypt but not decrypt, so the API cannot read sessions back", async () => {
    const view = encryptOnly(new EnvKeyProvider(KEY));

    expect(typeof view.encrypt).toBe("function");
    expect("decrypt" in view).toBe(false);

    // What it encrypts is still readable by a full provider (i.e. the worker).
    const encrypted = await view.encrypt(SESSION);
    expect(await new EnvKeyProvider(KEY).decrypt(encrypted)).toBe(SESSION);
  });
});
