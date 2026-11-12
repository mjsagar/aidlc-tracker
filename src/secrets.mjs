// Secrets at rest: AES-256-GCM with a key held outside the database.
// The key comes from TRACKER_SECRET_KEY (32 bytes, base64), or is generated once
// into a 0600 file beside the database.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export function loadKey({ envKey = process.env.TRACKER_SECRET_KEY, dbPath } = {}) {
  if (envKey) {
    const key = Buffer.from(envKey, "base64");
    if (key.length !== 32) throw new Error("TRACKER_SECRET_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  if (!dbPath || dbPath === ":memory:") return randomBytes(32); // tests: lives as long as the process
  const file = join(dirname(dbPath), "secret.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function encrypt(key, plain) {
  if (plain == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

export function decrypt(key, sealed) {
  if (sealed == null) return null;
  const [v, iv, tag, body] = String(sealed).split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Constant-time check of a GitHub `X-Hub-Signature-256` header against the raw body. */
export function verifyGithubSignature(secret, rawBody, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
