// A small in-process stand-in for the GitHub REST API and OAuth endpoints the tracker uses.
// Repos are real git object graphs (blob, tree and commit hashes computed as git does),
// so tree and blob SHAs behave like GitHub's.

import { createServer } from "node:http";
import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

function gitObject(type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { sha: sha1(Buffer.concat([Buffer.from(`${type} ${b.length}\0`), b])), body: b };
}

export function readDir(root) {
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  };
  walk(root);
  return files;
}

export class FakeGitHub {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.pem = privateKey.export({ type: "pkcs1", format: "pem" });
    this.publicKey = publicKey;
    this.appId = 4242;
    this.objects = new Map(); // sha -> {type, ...}
    this.repos = new Map(); // fullName -> {id, fullName, defaultBranch, branches: Map name -> {commit, files}}
    this.installations = new Map(); // id -> {id, account, repos: Set fullName}
    this.users = new Map(); // login -> {id, login, name, installations: Map installId -> Set fullName}
    this.codes = new Map(); // oauth code -> login
    this.userTokens = new Map(); // token -> login
    this.installTokens = new Map(); // token -> installation id
    this.requests = [];
    this.failNext = null; // {match: RegExp, status, headers, body}
    this.perPage = null;
  }

  // ---- building repos

  addRepo(fullName, files, { id, defaultBranch = "main" } = {}) {
    const repo = { id: id ?? 1000 + this.repos.size, fullName, defaultBranch, branches: new Map() };
    this.repos.set(fullName, repo);
    this.commit(fullName, defaultBranch, new Map(files));
    return repo;
  }

  /** Makes a new commit on a branch with the given full file set. */
  commit(fullName, branch, files) {
    const repo = this.repos.get(fullName);
    const tree = this.buildTree(files);
    const c = gitObject("commit", `tree ${tree}\nparent ${repo.branches.get(branch)?.commit ?? "none"}\n\n${randomBytes(6).toString("hex")}\n`);
    this.objects.set(c.sha, { type: "commit", tree });
    repo.branches.set(branch, { commit: c.sha, files });
    return c.sha;
  }

  setFile(fullName, branch, path, content) {
    const files = new Map(this.repos.get(fullName).branches.get(branch).files);
    if (content === null) files.delete(path); else files.set(path, content);
    return this.commit(fullName, branch, files);
  }

  getFile(fullName, branch, path) { return this.repos.get(fullName).branches.get(branch).files.get(path); }

  buildTree(files) {
    const root = new Map();
    for (const [path, content] of files) {
      const parts = path.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) {
        if (!node.has(dir)) node.set(dir, new Map());
        node = node.get(dir);
      }
      node.set(parts.at(-1), content);
    }
    const hashNode = (node) => {
      const entries = [...node].map(([name, v]) => {
        if (v instanceof Map) return { name, mode: "40000", type: "tree", sha: hashNode(v) };
        const blob = gitObject("blob", v);
        this.objects.set(blob.sha, { type: "blob", content: v, size: blob.body.length });
        return { name, mode: "100644", type: "blob", sha: blob.sha, size: blob.body.length };
      }).sort((a, b) => (a.type === "tree" ? `${a.name}/` : a.name).localeCompare(b.type === "tree" ? `${b.name}/` : b.name));
      const body = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex")])));
      const t = gitObject("tree", body);
      this.objects.set(t.sha, { type: "tree", entries });
      return t.sha;
    };
    return hashNode(root);
  }

  install(id, account, fullNames) {
    this.installations.set(id, { id, account, repos: new Set(fullNames) });
  }

  addUser(login, id, access) {
    this.users.set(login, { id, login, name: login.toUpperCase(), access }); // access: {installId: [fullName]}
  }

  count(re) { return this.requests.filter((r) => re.test(r)).length; }

  // ---- HTTP

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
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString();

    // Web pages, auto-approved for demos: app creation from a manifest, installation, sign-in.
    if (/^\/(organizations\/[^/]+\/)?settings\/apps\/new$/.test(p) && req.method === "POST") {
      const manifest = JSON.parse(new URLSearchParams(rawBody).get("manifest"));
      this.lastManifest = manifest;
      res.writeHead(302, { Location: `${manifest.redirect_url}?code=good-code&state=${encodeURIComponent(url.searchParams.get("state"))}` });
      return res.end();
    }
    if (/^\/apps\/[^/]+\/installations\/new$/.test(p) && this.setupUrl) {
      res.writeHead(302, { Location: `${this.setupUrl}?installation_id=${[...this.installations.keys()][0]}&setup_action=install` });
      return res.end();
    }
    if (p === "/login/oauth/authorize" && this.demoUser) {
      res.writeHead(302, { Location: `${url.searchParams.get("redirect_uri")}?code=${this.authorize(this.demoUser)}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
      return res.end();
    }

    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    this.requests.push(`${req.method} ${p}${url.search}${req.headers["if-none-match"] ? " [conditional]" : ""}`);

    if (this.failNext && this.failNext.match.test(`${req.method} ${p}`)) {
      const f = this.failNext; this.failNext = null;
      return reply(f.status, f.body ?? { message: "fail" }, f.headers ?? {});
    }

    const paginate = (items, key) => {
      const per = this.perPage ?? Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = items.slice((page - 1) * per, page * per);
      const headers = {};
      if (page * per < items.length) {
        const next = new URL(url); next.searchParams.set("page", String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return reply(200, key ? { total_count: items.length, [key]: slice } : slice, headers);
    };
    const repoJson = (r) => ({ id: r.id, full_name: r.fullName, default_branch: r.defaultBranch, html_url: `${this.url}/${r.fullName}` });
    const etagged = (etag, payload) => {
      const tag = `"${etag}"`;
      if (req.headers["if-none-match"] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
      return reply(200, payload, { etag: tag });
    };

    let m;
    // App manifest conversion (no auth)
    if ((m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(p)) && req.method === "POST") {
      if (m[1] !== "good-code") return reply(404, { message: "Not Found" });
      return reply(201, { id: this.appId, slug: "aidlc-tracker-test", name: "AI-DLC Tracker test", owner: { login: "acme" },
        html_url: `${this.url}/apps/aidlc-tracker-test`, client_id: "Iv1.client", client_secret: "client-secret", webhook_secret: "hook-secret", pem: this.pem });
    }
    // As the app (JWT)
    if (p.startsWith("/app/")) {
      if (!this.verifyJwt(auth)) return reply(401, { message: "Bad JWT" });
      if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && req.method === "POST") {
        if (!this.installations.has(Number(m[1]))) return reply(404, { message: "Not Found" });
        const token = `ghs_${randomBytes(8).toString("hex")}`;
        this.installTokens.set(token, Number(m[1]));
        return reply(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) {
        const i = this.installations.get(Number(m[1]));
        return i ? reply(200, { id: i.id, account: { login: i.account } }) : reply(404, { message: "Not Found" });
      }
      if (p === "/app/installations") return paginate([...this.installations.values()].map((i) => ({ id: i.id, account: { login: i.account } })));
    }
    // As an installation
    const inst = this.installations.get(this.installTokens.get(auth));
    if (p === "/installation/repositories") {
      if (!inst) return reply(401, { message: "Bad credentials" });
      return paginate([...inst.repos].map((n) => repoJson(this.repos.get(n))), "repositories");
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/.exec(p))) {
      if (!inst) return reply(401, { message: "Bad credentials" });
      if (!inst.repos.has(m[1])) return reply(404, { message: "Not Found" });
      const repo = this.repos.get(m[1]);
      const rest = m[2];
      let n;
      if ((n = /^branches\/(.+)$/.exec(rest))) {
        const b = repo.branches.get(decodeURIComponent(n[1]));
        if (!b) return reply(404, { message: "Branch not found" });
        return etagged(b.commit, { name: n[1], commit: { sha: b.commit, commit: { tree: { sha: this.objects.get(b.commit).tree } } } });
      }
      if ((n = /^git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
        const t = this.objects.get(n[1]);
        if (!t || t.type !== "tree") return reply(404, { message: "Not Found" });
        const recursive = url.searchParams.get("recursive") === "1";
        const list = [];
        const add = (tree, prefix) => {
          for (const e of tree.entries) {
            list.push({ path: `${prefix}${e.name}`, mode: e.mode, type: e.type, sha: e.sha, ...(e.size !== undefined ? { size: e.size } : {}) });
            if (recursive && e.type === "tree") add(this.objects.get(e.sha), `${prefix}${e.name}/`);
          }
        };
        add(t, "");
        const truncated = recursive && this.truncateOver != null && list.length > this.truncateOver;
        return etagged(`${n[1]}${recursive ? "r" : ""}${truncated ? "t" : ""}`, { sha: n[1], tree: truncated ? list.slice(0, this.truncateOver) : list, truncated });
      }
      if ((n = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
        const b = this.objects.get(n[1]);
        if (!b || b.type !== "blob") return reply(404, { message: "Not Found" });
        return reply(200, { sha: n[1], size: b.size, encoding: "base64", content: Buffer.from(b.content).toString("base64") });
      }
      return reply(404, { message: "Not Found" });
    }
    // OAuth (web host) and as a user
    if (p === "/login/oauth/access_token" && req.method === "POST") {
      const login = this.codes.get(body.code);
      if (!login || body.client_id !== "Iv1.client" || body.client_secret !== "client-secret") return reply(200, { error: "bad_verification_code" });
      this.codes.delete(body.code);
      const token = `ghu_${randomBytes(8).toString("hex")}`;
      this.userTokens.set(token, login);
      return reply(200, { access_token: token, token_type: "bearer" });
    }
    const user = this.users.get(this.userTokens.get(auth));
    if (p === "/user") return user ? reply(200, { id: user.id, login: user.login, name: user.name, avatar_url: null }) : reply(401, { message: "Bad credentials" });
    if (p === "/user/installations") {
      if (!user) return reply(401, { message: "Bad credentials" });
      return paginate(Object.keys(user.access).map((id) => ({ id: Number(id), account: { login: this.installations.get(Number(id))?.account } })), "installations");
    }
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      if (!user) return reply(401, { message: "Bad credentials" });
      return paginate((user.access[m[1]] ?? []).map((n) => repoJson(this.repos.get(n))), "repositories");
    }
    return reply(404, { message: `Fake GitHub has no ${req.method} ${p}` });
  }

  /** Issues an OAuth code for a user, as GitHub would after they approve. */
  authorize(login) {
    const code = `code_${randomBytes(4).toString("hex")}`;
    this.codes.set(code, login);
    return code;
  }

  verifyJwt(jwt) {
    const [h, pl, sig] = String(jwt).split(".");
    if (!sig) return false;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${pl}`);
    if (!v.verify(this.publicKey, Buffer.from(sig, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(pl, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === String(this.appId) && claims.exp > now && claims.exp - claims.iat <= 600;
  }
}
