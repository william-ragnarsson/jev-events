import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import type { Credentials } from "../connection.js";

const PREFIX = "v1:";
const derived = new Map<string, Buffer>();

/** A new random encryption key for `JEV_EVENTS_KEY`. `npx jev-events key` prints one. */
export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The 32-byte key for a key string: the string itself when it is 32 bytes of base64 (what
 * `generateKey` makes), otherwise one derived from it, so a passphrase works too.
 */
export function encryptionKey(key: string | undefined = process.env.JEV_EVENTS_KEY): Buffer | undefined {
  if (!key) return undefined;
  let bytes = derived.get(key);
  if (!bytes) {
    const decoded = /^[A-Za-z0-9+/_-]{43}=?$/.test(key) ? Buffer.from(key, "base64") : undefined;
    bytes = decoded?.length === 32 ? decoded : scryptSync(key, "jev-events", 32);
    derived.set(key, bytes);
  }
  return bytes;
}

/** Encrypt credentials with AES-256-GCM. */
export function seal(credentials: Credentials, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Decrypt sealed credentials. Throws when the key is wrong or the data was changed. */
export function unseal(sealed: string, key: Buffer): Credentials {
  const data = Buffer.from(sealed.slice(PREFIX.length), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const json = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(json) as Credentials;
}

export const NO_KEY_PROBLEM = "its tokens are encrypted; set JEV_EVENTS_KEY to the key they were saved with";
export const WRONG_KEY_PROBLEM = "couldn't decrypt its tokens with this JEV_EVENTS_KEY; sign in again";
