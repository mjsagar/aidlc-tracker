// A small stand-in for the GitLab API v4 and OAuth endpoints the tracker uses.
// Repository contents reuse FakeGitHub's git object store, so tree and blob ids are real git hashes.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { FakeGitHub } from "./fake-github.mjs";

export class FakeGitLab {
  constructor() {
    this.git = new FakeGitHub(); // used only as a git object store
    this.projects = new Map(); // path -> {id, path}
    this.tokens = new Map(); // token -> {userId, scopes, expiresAt, kind}
    this.users = new Map(); // id -> {id, username, name, projects: Set(path)}
    this.oauthApps = new Map(); // clientId -> secret
    this.codes = new Map(); // code -> {userId, challenge, redirectUri}
    this.refreshTokens = new Map(); // refresh -> userId
    this.requests = [];
    this.failNext = null;
    this.perPage = null;
  }

  addProject(path, files, { id } = {}) {
    const p = { id: id ?? 700 + this.projects.size, path };
    this.projects.set(path, p);
    this.git.addRepo(path, files, { id: p.id });
    return p;
  }
  setFile(path, branch, file, content) { return this.git.setFile(path, branch, file, content); }
  getFile(path, branch, file) { return this.git.getFile(path, branch, file); }

  addUser(id, username, projects) { this.users.set(id, { id, username, name: username.toUpperCase(), projects: new Set(projects) }); }
  addToken(token, userId, { scopes = ["read_api"], expiresAt = null, kind = "personal" } = {}) { this.tokens.set(token, { userId, scopes, expiresAt, kind }); }

  count(re) { return this.requests.filter((r) => re.test(r)).length; }

  async start() {
    this.server = createServer((req, res) => this.handle(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    }));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  stop() { return new Promise((r) => this.server.close(r)); }

  async handle(req, res) {
    const url = new URL(req.url, this.url);
    const p = url.pathname;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    this.requests.push(`${req.method} ${p}${url.search}`);
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "RateLimit-Remaining": "1999", "RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60), ...headers });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    if (this.failNext && this.failNext.match.test(`${req.method} ${p}`)) {
      const f = this.failNext; this.failNext = null;
      return reply(f.status, f.body ?? { message: "fail" }, f.headers ?? {});
    }

    // OAuth
    if (p === "/oauth/authorize" && this.demoUserId) {
      const code = this.issueCode(this.demoUserId, url.searchParams.get("code_challenge"), url.searchParams.get("redirect_uri"));
      res.writeHead(302, { Location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
      return res.end();
    }
    if (p === "/oauth/token" && req.method === "POST") {
      if (this.oauthApps.get(body.client_id) !== body.client_secret) return reply(401, { error: "invalid_client" });
      let userId;
      if (body.grant_type === "authorization_code") {
        const c = this.codes.get(body.code);
        this.codes.delete(body.code);
        const challenge = createHash("sha256").update(String(body.code_verifier ?? "")).digest("base64url");
        if (!c || c.challenge !== challenge || c.redirectUri !== body.redirect_uri) return reply(400, { error: "invalid_grant" });
        userId = c.userId;
      } else if (body.grant_type === "refresh_token") {
        userId = this.refreshTokens.get(body.refresh_token);
        this.refreshTokens.delete(body.refresh_token); // rotation: each refresh token works once
        if (!userId) return reply(400, { error: "invalid_grant" });
      } else return reply(400, { error: "unsupported_grant_type" });
      const token = `oauth_${randomBytes(6).toString("hex")}`;
      const refresh = `refresh_${randomBytes(6).toString("hex")}`;
      this.addToken(token, userId, { kind: "oauth" });
      this.refreshTokens.set(refresh, userId);
      return reply(200, { access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 7200, created_at: Math.floor(Date.now() / 1000) });
    }

    if (!p.startsWith("/api/v4/")) return reply(404, { message: "404 Not Found" });
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const tok = this.tokens.get(auth);
    if (!tok) return reply(401, { message: "401 Unauthorized" });
    const user = this.users.get(tok.userId);
    const api = p.slice("/api/v4".length);
    const canRead = (proj) => proj && user.projects.has(proj.path);
    const projectJson = (proj) => ({ id: proj.id, path_with_namespace: proj.path, default_branch: "main", web_url: `${this.url}/${proj.path}` });
    const findProject = (ref) => {
      const id = decodeURIComponent(ref);
      return [...this.projects.values()].find((x) => String(x.id) === id || x.path === id);
    };
    const paginated = (items) => {
      const per = this.perPage ?? Number(url.searchParams.get("per_page") ?? 20);
      const start = Number(url.searchParams.get("page_token") ?? 0);
      const headers = {};
      if (start + per < items.length) {
        const next = new URL(url); next.searchParams.set("page_token", String(start + per));
        headers.Link = `<${next}>; rel="next"`;
      }
      return reply(200, items.slice(start, start + per), headers);
    };

    if (api === "/user") return reply(200, { id: user.id, username: user.username, name: user.name, avatar_url: null });
    if (api === "/personal_access_tokens/self") return reply(200, { scopes: tok.scopes, expires_at: tok.expiresAt, active: true });
    if (api === "/projects") {
      const search = url.searchParams.get("search") ?? "";
      return reply(200, [...this.projects.values()].filter((x) => canRead(x) && x.path.includes(search)).map(projectJson));
    }
    let m;
    if ((m = /^\/projects\/([^/]+)$/.exec(api))) {
      const proj = findProject(m[1]);
      return canRead(proj) ? reply(200, projectJson(proj)) : reply(404, { message: "404 Project Not Found" });
    }
    if ((m = /^\/projects\/([^/]+)\/repository\/(.+)$/.exec(api))) {
      const proj = findProject(m[1]);
      if (!canRead(proj)) return reply(404, { message: "404 Project Not Found" });
      const repo = this.git.repos.get(proj.path);
      let n;
      if ((n = /^branches\/(.+)$/.exec(m[2]))) {
        const b = repo.branches.get(decodeURIComponent(n[1]));
        return b ? reply(200, { name: decodeURIComponent(n[1]), commit: { id: b.commit } }) : reply(404, { message: "404 Branch Not Found" });
      }
      if (m[2] === "tree") {
        const commit = this.git.objects.get(url.searchParams.get("ref")) ?? this.git.objects.get(repo.branches.get(url.searchParams.get("ref"))?.commit);
        if (!commit) return reply(404, { message: "404 Tree Not Found" });
        let tree = this.git.objects.get(commit.tree);
        const path = url.searchParams.get("path") ?? "";
        for (const part of path.split("/").filter(Boolean)) {
          const e = tree.entries.find((x) => x.name === part && x.type === "tree");
          if (!e) return reply(404, { message: "404 Tree Not Found" });
          tree = this.git.objects.get(e.sha);
        }
        const recursive = url.searchParams.get("recursive") === "true";
        const out = [];
        const walk = (t, prefix) => {
          for (const e of t.entries) {
            out.push({ id: e.sha, name: e.name, type: e.type, path: `${prefix}${e.name}`, mode: e.mode });
            if (recursive && e.type === "tree") walk(this.git.objects.get(e.sha), `${prefix}${e.name}/`);
          }
        };
        walk(tree, path ? `${path}/` : "");
        return paginated(out);
      }
      if ((n = /^blobs\/([0-9a-f]{40})$/.exec(m[2]))) {
        const b = this.git.objects.get(n[1]);
        if (!b || b.type !== "blob") return reply(404, { message: "404 Blob Not Found" });
        return reply(200, { sha: n[1], size: b.size, encoding: "base64", content: Buffer.from(b.content).toString("base64") });
      }
    }
    return reply(404, { message: `Fake GitLab has no ${req.method} ${p}` });
  }

  issueCode(userId, challenge, redirectUri) {
    const code = `glcode_${randomBytes(4).toString("hex")}`;
    this.codes.set(code, { userId, challenge, redirectUri });
    return code;
  }
}
