// Minimal GitHub REST client for a GitHub App: app JWT, installation tokens,
// conditional requests (ETag; a 304 does not count against the rate limit),
// pagination and rate-limit tracking. No dependencies.

import { createSign } from "node:crypto";

const API_VERSION = "2022-11-28";
const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export class GitHubError extends Error {
  constructor(status, message, { retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** RS256 JWT for authenticating as the app (valid up to 10 minutes; we use 9). */
export function appJwt(appId, pem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift, as GitHub recommends
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ iat, exp: iat + 9 * 60, iss: String(appId) });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(pem).toString("base64url")}`;
}

export class GitHubClient {
  /**
   * @param {{apiUrl?: string, webUrl?: string, appId?: string, pem?: string, clientId?: string, clientSecret?: string,
   *   cache?: {get(url: string): {etag: string, body: string}|undefined, set(url: string, etag: string, body: string): void},
   *   fetchImpl?: typeof fetch}} opts
   */
  constructor({ apiUrl = "https://api.github.com", webUrl = "https://github.com", appId, pem, clientId, clientSecret, cache, fetchImpl = fetch } = {}) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.webUrl = webUrl.replace(/\/$/, "");
    this.appId = appId;
    this.pem = pem;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.cache = cache;
    this.fetch = fetchImpl;
    this.tokens = new Map(); // installation id -> {token, expiresAt}
    this.rate = { remaining: null, reset: null };
  }

  get configured() { return Boolean(this.appId && this.pem); }

  async request(path, { method = "GET", token, body, conditional = false, accept = "application/vnd.github+json" } = {}) {
    const url = path.startsWith("http") ? path : `${this.apiUrl}${path}`;
    const headers = { Accept: accept, "X-GitHub-Api-Version": API_VERSION, "User-Agent": "aidlc-tracker" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const cached = conditional && this.cache ? this.cache.get(url) : undefined;
    if (cached) headers["If-None-Match"] = cached.etag;

    const res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) this.rate = { remaining: Number(remaining), reset: Number(res.headers.get("x-ratelimit-reset")) * 1000 };

    if (res.status === 304 && cached) return { status: 304, data: JSON.parse(cached.body), notModified: true, headers: res.headers };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const limited = (res.status === 403 || res.status === 429) && (remaining === "0" || res.headers.get("retry-after"));
      const retryAfter = limited ? (Number(res.headers.get("retry-after")) * 1000 || Math.max(0, this.rate.reset - Date.now())) : null;
      throw new GitHubError(res.status, `GitHub ${method} ${path} failed: ${res.status} ${data?.message ?? text.slice(0, 200)}`, { retryAfter });
    }
    const etag = res.headers.get("etag");
    if (conditional && etag && this.cache) this.cache.set(url, etag, text);
    return { status: res.status, data, notModified: false, headers: res.headers };
  }

  /** Follows `Link: rel="next"`, concatenating `key` (or the array itself). */
  async paginate(path, { token, key } = {}) {
    const out = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { data, headers } = await this.request(next, { token });
      out.push(...(key ? data[key] : data));
      next = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }

  // ---- as the app

  async convertManifest(code) {
    return (await this.request(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", body: {} })).data;
  }

  async installationToken(installationId) {
    const hit = this.tokens.get(String(installationId));
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
    const { data } = await this.request(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: appJwt(this.appId, this.pem), body: {} });
    this.tokens.set(String(installationId), { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  async getInstallation(installationId) {
    return (await this.request(`/app/installations/${installationId}`, { token: appJwt(this.appId, this.pem) })).data;
  }

  async listAppInstallations() {
    return this.paginate("/app/installations", { token: appJwt(this.appId, this.pem) });
  }

  // ---- as an installation

  async installationRepos(installationId) {
    return this.paginate("/installation/repositories", { token: await this.installationToken(installationId), key: "repositories" });
  }

  async branchHead(installationId, fullName, branch) {
    const token = await this.installationToken(installationId);
    const { data, notModified } = await this.request(`/repos/${fullName}/branches/${encodeURIComponent(branch)}`, { token, conditional: true });
    return { notModified, commitSha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
  }

  async tree(installationId, fullName, sha, recursive = false) {
    const token = await this.installationToken(installationId);
    return (await this.request(`/repos/${fullName}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`, { token, conditional: true })).data;
  }

  async blob(installationId, fullName, sha) {
    const token = await this.installationToken(installationId);
    const { data } = await this.request(`/repos/${fullName}/git/blobs/${sha}`, { token });
    return data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
  }

  // ---- sign-in (user-to-server)

  authorizeUrl({ state, redirectUri }) {
    const q = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri });
    return `${this.webUrl}/login/oauth/authorize?${q}`;
  }

  async exchangeCode(code, redirectUri) {
    const res = await this.fetch(`${this.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "aidlc-tracker" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: redirectUri }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new GitHubError(401, `Sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
    return data;
  }

  async currentUser(userToken) {
    return (await this.request("/user", { token: userToken })).data;
  }

  /** Repo ids the signed-in person can see through this app's installations. */
  async userRepoIds(userToken) {
    const installs = await this.paginate("/user/installations", { token: userToken, key: "installations" });
    const ids = [];
    for (const i of installs) {
      const repos = await this.paginate(`/user/installations/${i.id}/repositories`, { token: userToken, key: "repositories" });
      ids.push(...repos.map((r) => String(r.id)));
    }
    return ids;
  }
}
