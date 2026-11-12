// Minimal GitLab REST client (API v4). Projects are read with an access token that has
// the read_api scope; people sign in through an OAuth application (authorization code + PKCE).

import { createHash, randomBytes } from "node:crypto";

export class GitLabError extends Error {
  constructor(status, message, { retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const enc = (id) => encodeURIComponent(String(id));

export class GitLabClient {
  /** @param {{baseUrl?: string, clientId?: string, clientSecret?: string, fetchImpl?: typeof fetch}} opts */
  constructor({ baseUrl = "https://gitlab.com", clientId, clientSecret, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.rate = { remaining: null, reset: null };
  }

  async request(path, { token, method = "GET", body } = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}/api/v4${path}`;
    const headers = { Accept: "application/json", "User-Agent": "aidlc-tracker" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const remaining = res.headers.get("ratelimit-remaining");
    if (remaining !== null) this.rate = { remaining: Number(remaining), reset: Number(res.headers.get("ratelimit-reset")) * 1000 };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const retryAfter = res.status === 429 ? (Number(res.headers.get("retry-after")) * 1000 || Math.max(1000, (this.rate.reset ?? 0) - Date.now())) : null;
      const msg = typeof data === "object" && data ? data.message ?? data.error ?? JSON.stringify(data) : text.slice(0, 200);
      throw new GitLabError(res.status, `GitLab ${method} ${path.split("?")[0]} failed: ${res.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, { retryAfter });
    }
    return { data, headers: res.headers };
  }

  /** Follows `Link: rel="next"` (offset or keyset pagination). */
  async paginate(path, { token } = {}) {
    const out = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { data, headers } = await this.request(next, { token });
      out.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }

  // ---- with the read token

  async currentUser(token) { return (await this.request("/user", { token })).data; }

  /** The token's own record: scopes and expiry. Works for personal, group and project access tokens. */
  async tokenInfo(token) { return (await this.request("/personal_access_tokens/self", { token })).data; }

  /** Accepts a numeric id or a "group/project" path. */
  async project(token, idOrPath) { return (await this.request(`/projects/${enc(idOrPath)}`, { token })).data; }

  async memberProjects(token, search = "") {
    const q = new URLSearchParams({ membership: "true", simple: "true", order_by: "last_activity_at", ...(search ? { search } : {}) });
    return (await this.request(`/projects?${q}&per_page=50`, { token })).data;
  }

  async branchHead(token, projectId, branch) {
    const { data } = await this.request(`/projects/${enc(projectId)}/repository/branches/${enc(branch)}`, { token });
    return { commitSha: data.commit.id };
  }

  /** Lists a tree. GitLab returns each entry's path from the repository root. */
  async tree(token, projectId, { ref, path = "", recursive = false }) {
    const q = new URLSearchParams({ ref, ...(path ? { path } : {}), ...(recursive ? { recursive: "true" } : {}), pagination: "keyset" });
    return this.paginate(`/projects/${enc(projectId)}/repository/tree?${q}`, { token });
  }

  async blob(token, projectId, sha) {
    const { data } = await this.request(`/projects/${enc(projectId)}/repository/blobs/${sha}`, { token });
    return { size: data.size, content: data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content };
  }

  // ---- sign-in (OAuth, PKCE)

  authorizeUrl({ state, redirectUri, challenge }) {
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: "code", state, scope: "read_api",
      code_challenge: challenge, code_challenge_method: "S256" });
    return `${this.baseUrl}/oauth/authorize?${q}`;
  }

  async #token(params) {
    const res = await this.fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "aidlc-tracker" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new GitLabError(res.status === 200 ? 400 : res.status, `GitLab sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
    const created = (data.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    return { token: data.access_token, refresh: data.refresh_token ?? null, expiresAt: data.expires_in ? new Date(created + data.expires_in * 1000).toISOString() : null };
  }

  exchangeCode(code, redirectUri, verifier) {
    return this.#token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  }

  refresh(refreshToken) {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }
}
