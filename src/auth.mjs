// Sign-in with GitHub and/or GitLab, and sessions.
// A person sees a GitHub repo only if their GitHub account can read it through the app's
// installations, and a GitLab project only if their GitLab account can read it. One session
// can hold both sign-ins. Access is re-checked every hour.

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

function upsertUser(db, platform, user) {
  return db.prepare(`INSERT INTO users (platform, platform_user_id, login, name, avatar_url) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (platform, platform_user_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url
    RETURNING id`).get(platform, String(user.id), user.login, user.name ?? null, user.avatarUrl ?? null).id;
}

function providerColumns(key, provider, p) {
  const now = new Date().toISOString();
  return provider === "github"
    ? { github_login: p.login, github_token_enc: encrypt(key, p.token), github_repo_ids_json: JSON.stringify(p.repoIds), github_checked_at: now }
    : { gitlab_login: p.login, gitlab_token_enc: encrypt(key, p.token), gitlab_refresh_enc: encrypt(key, p.refresh ?? null),
      gitlab_expires_at: p.expiresAt ?? null, gitlab_project_ids_json: JSON.stringify(p.projectIds), gitlab_checked_at: now };
}

/**
 * Signs in with one provider. When `existingRaw` names a live session, the provider is added to it
 * (one person, both sign-ins); otherwise a new session starts. Returns the session's raw id.
 * @param {{provider: "github"|"gitlab", user: {id: string|number, login: string, name?: string, avatarUrl?: string},
 *   token: string, refresh?: string, expiresAt?: string, repoIds?: string[], projectIds?: string[]}} p
 */
export function signIn(db, key, p, existingRaw) {
  const cols = providerColumns(key, p.provider, p);
  const existing = existingRaw && db.prepare("SELECT id_hash FROM sessions WHERE id_hash = ? AND expires_at > ?").get(sha256(existingRaw), new Date().toISOString());
  if (existing) {
    db.prepare(`UPDATE sessions SET ${Object.keys(cols).map((c) => `${c} = ?`).join(", ")} WHERE id_hash = ?`).run(...Object.values(cols), existing.id_hash);
    return existingRaw;
  }
  const userId = upsertUser(db, p.provider, p.user);
  const raw = randomToken(32);
  const now = new Date();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  const all = { id_hash: sha256(raw), user_id: userId, ...cols, created_at: now.toISOString(), expires_at: new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString() };
  db.prepare(`INSERT INTO sessions (${Object.keys(all).join(", ")}) VALUES (${Object.keys(all).map(() => "?").join(", ")})`).run(...Object.values(all));
  return raw;
}

export function deleteSession(db, raw) {
  if (raw) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(raw));
}

const ids = (json) => new Set(JSON.parse(json ?? "[]").map(String));

/**
 * The signed-in person for this request, or null. Re-checks access with each provider when the
 * last check is over an hour old. A provider whose token was revoked is dropped from the session.
 */
export async function currentSession(ctx, req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const { db, key } = ctx;
  const row = db.prepare("SELECT s.*, u.login, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?").get(sha256(raw));
  if (!row || Date.parse(row.expires_at) < Date.now()) { deleteSession(db, raw); return null; }
  const stale = (t) => !t || Date.now() - Date.parse(t) > RECHECK_MS;
  const drop = (provider) => {
    const cols = provider === "github"
      ? ["github_login", "github_token_enc", "github_repo_ids_json", "github_checked_at"]
      : ["gitlab_login", "gitlab_token_enc", "gitlab_refresh_enc", "gitlab_expires_at", "gitlab_project_ids_json", "gitlab_checked_at"];
    db.prepare(`UPDATE sessions SET ${cols.map((c) => `${c} = NULL`).join(", ")} WHERE id_hash = ?`).run(row.id_hash);
    row[`${provider}_token_enc`] = null;
  };

  if (row.github_token_enc && stale(row.github_checked_at)) {
    const gh = ctx.github?.();
    try {
      if (gh) {
        const repoIds = await gh.userRepoIds(decrypt(key, row.github_token_enc));
        db.prepare("UPDATE sessions SET github_repo_ids_json = ?, github_checked_at = ? WHERE id_hash = ?").run(JSON.stringify(repoIds), new Date().toISOString(), row.id_hash);
        row.github_repo_ids_json = JSON.stringify(repoIds);
      }
    } catch (err) {
      if (err.status === 401) drop("github"); // revoked or expired: sign in again
      else ctx.log?.(`GitHub access re-check failed for ${row.github_login}: ${err.message}`); // keep the last list
    }
  }

  if (row.gitlab_token_enc && stale(row.gitlab_checked_at)) {
    const gl = ctx.gitlab?.();
    try {
      if (gl) {
        let token = decrypt(key, row.gitlab_token_enc);
        if (row.gitlab_expires_at && Date.parse(row.gitlab_expires_at) - Date.now() < 5 * 60_000) {
          const fresh = await gl.refresh(decrypt(key, row.gitlab_refresh_enc));
          token = fresh.token;
          db.prepare("UPDATE sessions SET gitlab_token_enc = ?, gitlab_refresh_enc = ?, gitlab_expires_at = ? WHERE id_hash = ?")
            .run(encrypt(key, fresh.token), encrypt(key, fresh.refresh), fresh.expiresAt, row.id_hash);
        }
        const projectIds = await ctx.gitlabVisible(token);
        db.prepare("UPDATE sessions SET gitlab_project_ids_json = ?, gitlab_checked_at = ? WHERE id_hash = ?").run(JSON.stringify(projectIds), new Date().toISOString(), row.id_hash);
        row.gitlab_project_ids_json = JSON.stringify(projectIds);
      }
    } catch (err) {
      if (err.status === 401 || err.status === 400) drop("gitlab");
      else ctx.log?.(`GitLab access re-check failed for ${row.gitlab_login}: ${err.message}`);
    }
  }

  if (!row.github_token_enc && !row.gitlab_token_enc) { deleteSession(db, raw); return null; }
  return {
    raw,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    github: row.github_token_enc ? { login: row.github_login, repoIds: ids(row.github_repo_ids_json) } : null,
    gitlab: row.gitlab_token_enc ? { login: row.gitlab_login, projectIds: ids(row.gitlab_project_ids_json) } : null,
  };
}
