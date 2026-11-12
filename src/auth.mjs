// Sign-in with GitHub (the GitHub App's own OAuth) and sessions.
// A person sees a GitHub repo only if their own GitHub account can read it through
// the app's installations; that list is refreshed every hour.

import { decrypt, encrypt, randomToken, sha256 } from "./secrets.mjs";

export const COOKIE = "tracker_session";
const SESSION_DAYS = 14;
const RECHECK_MS = 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, { secure, clear = false } = {}) {
  const attrs = [`${COOKIE}=${clear ? "" : encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attrs.push("Secure");
  attrs.push(clear ? "Max-Age=0" : `Max-Age=${SESSION_DAYS * 86400}`);
  return attrs.join("; ");
}

// ---- one-time states (sign-in and app setup)

export function newState(db, purpose, data = null) {
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - STATE_TTL_MS);
  const state = randomToken(24);
  db.prepare("INSERT INTO oauth_states (state, purpose, data, created_at) VALUES (?, ?, ?, ?)").run(state, purpose, data ? JSON.stringify(data) : null, Date.now());
  return state;
}

/** Returns the state's data if it exists, matches the purpose and is fresh; deletes it either way. */
export function takeState(db, state, purpose) {
  if (typeof state !== "string" || !state) return null;
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state);
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (!row || row.purpose !== purpose || Date.now() - row.created_at > STATE_TTL_MS) return null;
  return row.data ? JSON.parse(row.data) : {};
}

// ---- sessions

export function createSession(db, key, { user, token, repoIds }) {
  const userRow = db.prepare(`INSERT INTO users (platform, platform_user_id, login, name, avatar_url) VALUES ('github', ?, ?, ?, ?)
    ON CONFLICT (platform, platform_user_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url
    RETURNING id`).get(String(user.id), user.login, user.name ?? null, user.avatar_url ?? null);
  const raw = randomToken(32);
  const now = new Date();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare(`INSERT INTO sessions (id_hash, user_id, token_enc, repo_ids_json, checked_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(raw), userRow.id, encrypt(key, token), JSON.stringify(repoIds), now.toISOString(), now.toISOString(),
      new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString());
  return raw;
}

export function deleteSession(db, raw) {
  if (raw) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(raw));
}

/**
 * The signed-in person for this request, with their visible GitHub repo ids, or null.
 * Re-checks repo access with GitHub when the list is over an hour old.
 */
export async function currentSession(ctx, req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const { db, key } = ctx;
  const row = db.prepare(`SELECT s.*, u.login, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(sha256(raw));
  if (!row || Date.parse(row.expires_at) < Date.now()) { deleteSession(db, raw); return null; }
  let repoIds = JSON.parse(row.repo_ids_json);
  if (Date.now() - Date.parse(row.checked_at) > RECHECK_MS) {
    const client = ctx.github();
    try {
      if (client) {
        repoIds = await client.userRepoIds(decrypt(key, row.token_enc));
        db.prepare("UPDATE sessions SET repo_ids_json = ?, checked_at = ? WHERE id_hash = ?").run(JSON.stringify(repoIds), new Date().toISOString(), row.id_hash);
      }
    } catch (err) {
      if (err.status === 401) { deleteSession(db, raw); return null; } // token revoked or expired: sign in again
      ctx.log?.(`Repo access re-check failed for ${row.login}: ${err.message}`); // keep the last list; try again next request
    }
  }
  return { raw, login: row.login, name: row.name, avatarUrl: row.avatar_url, repoIds: new Set(repoIds.map(String)) };
}
