import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt, hashToken, randomToken } from "./crypto";

describe("crypto", () => {
  it("round-trips UTF-8 plaintext through encrypt/decrypt", () => {
    const key = deriveKey("a-test-secret");
    const plaintext = "gho_exampleToken—with-ünïcode";
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it("fails to decrypt with a key from a different secret", () => {
    const payload = encrypt("secret-token", deriveKey("secret-one"));
    expect(() => decrypt(payload, deriveKey("secret-two"))).toThrow();
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const key = deriveKey("a-test-secret");
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("throws on a malformed payload", () => {
    expect(() => decrypt("not-a-valid-payload", deriveKey("s"))).toThrow();
  });

  it("hashToken is deterministic and hex", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });

  it("randomToken returns distinct high-entropy values", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
