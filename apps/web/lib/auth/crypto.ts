import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/**
 * Cryptographic primitives for the reviewer session (issue #25). Node's
 * `node:crypto` only — no new dependency, and nothing here imports Next or the
 * DB so it runs in the plain Vitest `node` environment.
 *
 * The session cookie carries a high-entropy opaque token; the DB stores only its
 * SHA-256 hash (the raw credential never lands in a row). The GitHub access /
 * refresh tokens are encrypted at rest with AES-256-GCM under a key derived from
 * `SESSION_SECRET`, so a DB read disclosure does not hand over usable tokens.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const SESSION_TOKEN_BYTES = 32;

/** Derive a stable 32-byte AES key from the configured secret. */
export function deriveKey(secret: string): Buffer {
  // A fixed salt keeps the derived key deterministic across processes (sessions
  // outlive a single boot). The secret itself is the entropy; scrypt hardens it.
  return scryptSync(secret, "diffsense:session:v1", KEY_BYTES);
}

/**
 * AES-256-GCM encrypt. Output packs `iv:tag:ciphertext`, each base64url, so a
 * single string round-trips through a `text` column. A fresh random IV per call
 * means identical plaintexts produce different ciphertexts.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [b64url(iv), b64url(tag), b64url(ciphertext)].join(":");
}

/**
 * Reverse {@link encrypt}. Throws if the payload is malformed or the GCM auth
 * tag fails (wrong key or tampered ciphertext) — callers treat a throw as "this
 * session is unusable" rather than trusting partial output.
 */
export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("malformed encrypted payload");
  }
  const [iv, tag, ciphertext] = parts.map(fromB64url);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** A new opaque session token (base64url). Goes in the cookie, never the DB. */
export function randomToken(): string {
  return b64url(randomBytes(SESSION_TOKEN_BYTES));
}

/** SHA-256 hex of a token — the DB primary key, so the raw token is never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
