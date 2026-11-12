// HTTP app: JSON API, GitHub setup, sign-in, webhooks, and the static screens in public/.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";
import {
  addBranch, addLocalRepo, enqueue, enqueueAll, enqueueBackfill, removeBranch, removeInstallation, removeRepo, runAllJobs, upsertInstallation,
} from "./sync.mjs";
import { GitHubClient } from "./github/client.mjs";
import { handleGithubWebhook } from "./github/webhooks.mjs";
import { createSession, currentSession, deleteSession, newState, sessionCookie, takeState } from "./auth.mjs";
import { decrypt, encrypt, loadKey, randomToken, safeEqual } from "./secrets.mjs";
import { PARSER_VERSION, AIDLC_CHECKED_AGAINST } from "./version.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
const MAX_BODY = 16 * 1024;
const MAX_WEBHOOK_BODY = 25 * 1024 * 1024; // GitHub caps payloads at 25 MB
const STALE_DAYS = 7;
const RECONCILE_MS = 6 * 60 * 60 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isLoopback = (addr) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr);

/**
 * @param {{dbPath?: string, allowLocal?: boolean, pollSeconds?: number, githubPollSeconds?: number, localRepos?: string[],
 *   publicUrl?: string, setupToken?: string, githubApiUrl?: string, githubWebUrl?: string, secretKey?: string,
 *   fetchImpl?: typeof fetch, log?: (s: string) => void}} opts
 */
export function createApp({
  dbPath = ":memory:", allowLocal = true, pollSeconds = 30, githubPollSeconds = 30, localRepos = [],
  publicUrl = "http://127.0.0.1:3100", setupToken = null, githubApiUrl = "https://api.github.com", githubWebUrl = "https://github.com",
  secretKey, fetchImpl, log = () => {},
} = {}) {
  const db = openDb(dbPath);
  const key = loadKey({ envKey: secretKey ?? process.env.TRACKER_SECRET_KEY, dbPath });
  const started = Date.now();
  const base = publicUrl.replace(/\/$/, "");
  const secureCookies = base.startsWith("https://");
  const publicIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

  // ---------- GitHub app, built from the stored credentials

  let client = null;
  let clientFor = null;
  const appRow = () => db.prepare("SELECT * FROM github_app WHERE id = 1").get();
  const httpCache = {
    get: (url) => db.prepare("SELECT etag, body FROM http_cache WHERE url = ?").get(url),
    set: (url, etag, body) => db.prepare("INSERT INTO http_cache (url, etag, body, stored_at) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET etag = excluded.etag, body = excluded.body, stored_at = excluded.stored_at").run(url, etag, body, new Date().toISOString()),
  };
  const github = () => {
    const row = appRow();
    if (!row) return null;
    if (clientFor !== row.app_id) {
      client = new GitHubClient({ apiUrl: githubApiUrl, webUrl: githubWebUrl, appId: row.app_id, pem: decrypt(key, row.pem_enc),
        clientId: row.client_id, clientSecret: decrypt(key, row.client_secret_enc), cache: httpCache, fetchImpl });
      clientFor = row.app_id;
    }
    return client;
  };
  // A bare client for the one call made before any app exists (manifest conversion).
  const bareGithub = () => new GitHubClient({ apiUrl: githubApiUrl, webUrl: githubWebUrl, fetchImpl });
  const ctx = { db, key, github, log, webhookSecret: () => { const r = appRow(); return r?.webhook_secret_enc ? decrypt(key, r.webhook_secret_enc) : null; } };

  // ---------- worker and schedules

  let running = null;
  let again = false;
  // One worker at a time; a kick while it runs makes it go round again. Resolves to the job results of that run.
  const kick = () => {
    if (running) { again = true; return running; }
    running = (async () => {
      const results = [];
      do { again = false; results.push(...await runAllJobs(ctx)); } while (again);
      return results;
    })().catch((err) => { log(`Worker failed: ${err.stack ?? err}`); return []; }).finally(() => { running = null; });
    return running;
  };
  const idle = async () => { while (running) await running; };

  const reconcileGithub = async () => {
    const c = github();
    if (!c) return;
    try {
      const installs = await c.listAppInstallations();
      const seen = new Set();
      for (const i of installs) {
        seen.add(String(i.id));
        enqueueBackfill(db, upsertInstallation(db, { installationId: i.id, account: i.account?.login ?? null }), "reconcile");
      }
      for (const row of db.prepare("SELECT external_id FROM connections WHERE platform = 'github'").all()) {
        if (!seen.has(row.external_id)) removeInstallation(db, row.external_id);
      }
    } catch (err) { log(`GitHub reconcile failed: ${err.message}`); }
    kick();
  };

  for (const path of localRepos) {
    try { addLocalRepo(db, path); } catch (err) { log(`Could not add ${path}: ${err.message}`); }
  }
  enqueueAll(db, "startup");
  const ready = (async () => { await reconcileGithub(); await kick(); await idle(); })();

  const timers = [];
  const every = (seconds, fn) => { if (seconds > 0) { const t = setInterval(fn, seconds * 1000); t.unref(); timers.push(t); } };
  every(pollSeconds, () => { enqueueAll(db, "poll", { platform: "local" }); kick(); });
  every(githubPollSeconds, () => { if (appRow()) { enqueueAll(db, "poll", { platform: "github" }); kick(); } });
  every(RECONCILE_MS / 1000, reconcileGithub);

  // ---------- who can see what

  const authRequired = () => Boolean(appRow());
  /** Repo ids (our rows) this request may see; null means all. */
  const visibleRepoIds = (session) => {
    if (!authRequired()) return null;
    const rows = db.prepare("SELECT r.id, r.platform_repo_id, c.platform FROM repos r JOIN connections c ON c.id = r.connection_id").all();
    return new Set(rows.filter((r) => (r.platform === "local" ? allowLocal : session?.repoIds.has(r.platform_repo_id))).map((r) => r.id));
  };
  const canSee = (vis, repoId) => vis === null || vis.has(repoId);

  // ---------- queries

  const repoRows = (vis) => db.prepare(`
    SELECT r.id, r.full_name AS name, r.local_path AS path, r.web_url AS webUrl, r.aidlc_version AS aidlcVersion, r.default_branch AS defaultBranch,
      c.platform, c.account,
      b.id AS branchId, b.name AS branch, b.last_commit_sha AS commitSha, b.last_synced_at AS lastSyncedAt, b.sync_error AS syncError,
      (SELECT COUNT(*) FROM intents i WHERE i.branch_id = b.id) AS intents,
      (SELECT COALESCE(SUM(open_questions), 0) FROM intents i WHERE i.branch_id = b.id) AS openQuestions,
      (SELECT COALESCE(SUM(waiting), 0) FROM intents i WHERE i.branch_id = b.id) AS waiting
    FROM repos r JOIN connections c ON c.id = r.connection_id JOIN branches b ON b.repo_id = r.id
    ORDER BY c.platform DESC, r.full_name, b.name`).all().filter((r) => canSee(vis, r.id));

  /** One entry per repo with its branches nested. */
  const repoList = (vis) => {
    const byRepo = new Map();
    for (const r of repoRows(vis)) {
      if (!byRepo.has(r.id)) byRepo.set(r.id, { id: r.id, name: r.name, path: r.path, webUrl: r.webUrl, platform: r.platform, account: r.account,
        aidlcVersion: r.aidlcVersion, defaultBranch: r.defaultBranch, intents: 0, openQuestions: 0, waiting: 0, branches: [] });
      const repo = byRepo.get(r.id);
      repo.branches.push({ id: r.branchId, name: r.branch, commitSha: r.commitSha, lastSyncedAt: r.lastSyncedAt, syncError: r.syncError, intents: r.intents });
      repo.intents += r.intents; repo.openQuestions += r.openQuestions; repo.waiting += r.waiting;
    }
    return [...byRepo.values()];
  };

  const intentBase = `
    SELECT i.*, r.id AS repo_id, r.full_name AS repo_name, r.web_url AS repo_url, b.name AS branch_name
    FROM intents i JOIN branches b ON b.id = i.branch_id JOIN repos r ON r.id = b.repo_id`;
  const openQuestionRows = db.prepare(`SELECT q.*, i.id AS intent_row FROM questions q JOIN intents i ON i.id = q.intent_id WHERE q.open = 1`);

  // Link to a file on GitHub at the tracked branch; null for local folders.
  const fileUrl = (row, file, line) => (row.repo_url && file
    ? `${row.repo_url}/blob/${encodeURIComponent(row.branch_name).replace(/%2F/g, "/")}/${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`
    : null);

  const waitingSince = (snapshot, questions) => {
    const times = [...snapshot.blockers.map((b) => b.since), ...questions.map((q) => q.open_since ?? q.first_seen_open)]
      .map((t) => Date.parse(t ?? "")).filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)).toISOString().replace(/\.000Z$/, "Z") : null;
  };

  const intentSummary = (row, openQs) => {
    const snapshot = JSON.parse(row.snapshot_json);
    return {
      id: row.id, key: `${row.space}/${row.folder}`, label: snapshot.label,
      repo: { id: row.repo_id, name: row.repo_name, url: row.repo_url }, branch: row.branch_name,
      description: row.description, scope: row.scope, phase: row.phase, stage: row.stage, status: row.status,
      done: row.done, total: row.total, openQuestions: row.open_questions, waiting: row.waiting,
      waitingSince: waitingSince(snapshot, openQs), lastActivity: row.last_activity, createdOn: snapshot.createdOn,
      warnings: row.warnings, phases: snapshot.phases,
    };
  };

  function listIntents(params, vis) {
    const rows = db.prepare(`${intentBase} ORDER BY r.full_name, b.name, i.space, i.folder`).all().filter((r) => canSee(vis, r.repo_id));
    const open = openQuestionRows.all();
    let items = rows.map((r) => intentSummary(r, open.filter((q) => q.intent_row === r.id)));
    const repo = Number(params.get("repo"));
    if (repo) items = items.filter((i) => i.repo.id === repo);
    if (params.get("phase")) items = items.filter((i) => (i.phase ?? "").toLowerCase() === params.get("phase").toLowerCase());
    if (params.get("stale") === "1") {
      const cutoff = Date.now() - STALE_DAYS * 864e5;
      items = items.filter((i) => !i.lastActivity || Date.parse(i.lastActivity) < cutoff);
    }
    const t = (s, missing) => (s ? Date.parse(s) : missing);
    const sorts = {
      blocked: (a, b) => (b.waiting + b.openQuestions > 0) - (a.waiting + a.openQuestions > 0) ||
        t(a.waitingSince, Infinity) - t(b.waitingSince, Infinity) || b.openQuestions + b.waiting - (a.openQuestions + a.waiting),
      activity: (a, b) => t(b.lastActivity, -Infinity) - t(a.lastActivity, -Infinity),
      progress: (a, b) => (a.total ? a.done / a.total : 0) - (b.total ? b.done / b.total : 0),
    };
    const sort = sorts[params.get("sort") ?? "blocked"];
    if (!sort) throw httpError(400, "sort must be blocked, activity or progress");
    return items.sort((a, b) => sort(a, b) || a.key.localeCompare(b.key));
  }

  function getIntent(id, vis) {
    const row = db.prepare(`${intentBase} WHERE i.id = ?`).get(id);
    if (!row || !canSee(vis, row.repo_id)) throw httpError(404, "No such piece of work");
    const snapshot = JSON.parse(row.snapshot_json);
    const questions = db.prepare("SELECT * FROM questions WHERE intent_id = ? ORDER BY file, line").all(id).map((q) => {
      const parsed = snapshot.questions.find((p) => p.file === q.file && p.line === q.line) ?? {};
      return {
        kind: q.kind, number: q.number, trade: q.trade, title: q.title, prompt: parsed.prompt ?? "", options: parsed.options ?? [],
        multiSelect: parsed.multiSelect ?? false, answer: q.answer, open: !!q.open, file: q.file, line: q.answer_line ?? q.line,
        url: fileUrl(row, q.file, q.answer_line ?? q.line),
        phase: q.phase, stage: q.stage, unit: q.unit, openSince: q.open_since ?? q.first_seen_open, answeredAt: q.answered_at,
      };
    });
    const events = db.prepare("SELECT * FROM events WHERE intent_id = ? ORDER BY timestamp IS NULL, timestamp, shard, idx").all(id)
      .map((e) => ({ timestamp: e.timestamp, event: e.event, known: !!e.known, stage: e.stage, unit: e.unit, gitName: e.git_name,
        shard: e.shard, fields: JSON.parse(e.fields_json) }));
    const openQs = db.prepare("SELECT * FROM questions WHERE intent_id = ? AND open = 1").all(id);
    return {
      ...intentSummary(row, openQs),
      path: snapshot.path, stateUrl: fileUrl(row, `${snapshot.path}/aidlc-state.md`),
      project: snapshot.project, current: snapshot.current, stages: snapshot.stages, progress: snapshot.progress,
      blockers: snapshot.blockers, approvals: snapshot.approvals, notes: snapshot.notes, warningList: snapshot.warnings,
      questions, events, parserVersion: row.parser_version, syncedAt: row.updated_at,
    };
  }

  function inbox(params, vis) {
    const intents = db.prepare(intentBase).all().filter((r) => canSee(vis, r.repo_id));
    const byId = new Map(intents.map((r) => [r.id, r]));
    const items = [];
    for (const r of intents) {
      const snapshot = JSON.parse(r.snapshot_json);
      for (const b of snapshot.blockers) {
        const file = `${snapshot.path}/aidlc-state.md`;
        items.push({ type: b.type, intent: r.id, repo: { id: r.repo_id, name: r.repo_name }, branch: r.branch_name, key: `${r.space}/${r.folder}`,
          description: r.description, phase: b.phase, stage: b.stage, unit: b.unit, trade: null, since: b.since,
          revisionCount: b.revisionCount, title: null, file, line: null, url: fileUrl(r, file) });
      }
    }
    for (const q of openQuestionRows.all()) {
      const r = byId.get(q.intent_row);
      if (!r) continue;
      const line = q.answer_line ?? q.line;
      items.push({ type: q.kind, intent: r.id, repo: { id: r.repo_id, name: r.repo_name }, branch: r.branch_name, key: `${r.space}/${r.folder}`,
        description: r.description, phase: q.phase, stage: q.stage, unit: q.unit, trade: q.trade, since: q.open_since ?? q.first_seen_open,
        number: q.number, title: q.title, file: q.file, line, url: fileUrl(r, q.file, line) });
    }
    let out = items;
    const repo = Number(params.get("repo"));
    if (repo) out = out.filter((i) => i.repo.id === repo);
    if (params.get("trade")) out = out.filter((i) => (i.trade ?? "") === params.get("trade"));
    if (params.get("phase")) out = out.filter((i) => (i.phase ?? "").toLowerCase() === params.get("phase").toLowerCase());
    if (params.get("type")) {
      const want = params.get("type") === "questions" ? ["question", "summary"] : params.get("type") === "approvals" ? ["awaiting-approval", "revising"] : [params.get("type")];
      out = out.filter((i) => want.includes(i.type));
    }
    const minDays = Number(params.get("olderThanDays"));
    if (minDays > 0) out = out.filter((i) => i.since && Date.parse(i.since) < Date.now() - minDays * 864e5);
    const t = (s) => (s ? Date.parse(s) : Infinity);
    const order = { "awaiting-approval": 0, revising: 1, question: 2, summary: 3 };
    return out.sort((a, b) => t(a.since) - t(b.since) || order[a.type] - order[b.type] || a.key.localeCompare(b.key) ||
      (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
  }

  // ---------- GitHub app setup (manifest flow)

  function manifest(name) {
    const m = {
      name,
      url: base,
      redirect_url: `${base}/api/github/manifest/callback`,
      callback_urls: [`${base}/auth/github/callback`],
      setup_url: `${base}/api/github/installed`,
      setup_on_update: true,
      public: false,
      default_permissions: { contents: "read", metadata: "read" },
      description: "Reads AI-DLC records (aidlc/ folder) to track open questions, approvals and progress. Read-only.",
    };
    // GitHub refuses webhook URLs it cannot reach, so a tracker on this computer relies on polling instead.
    if (!publicIsLocal) {
      m.hook_attributes = { url: `${base}/api/webhooks/github`, active: true };
      m.default_events = ["push"];
    }
    return m;
  }

  const setupAllowed = (req) => isLoopback(req.socket.remoteAddress) || (setupToken && safeEqual(req.headers["x-setup-token"], setupToken));

  // ---------- HTTP

  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self' ${githubWebUrl}; frame-ancestors 'none'`,
  };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { ...securityHeaders, ...headers }); res.end(body); };
  const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { "Content-Type": TYPES[".json"], "Cache-Control": "no-store", ...headers });
  const redirect = (res, location, headers = {}) => send(res, 302, null, { Location: location, "Cache-Control": "no-store", ...headers });

  const readRaw = (req, limit) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(httpError(413, "Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const readJson = async (req) => {
    // Requiring application/json makes a cross-site form post impossible: browsers preflight it and we send no CORS headers.
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw httpError(415, "Send JSON (Content-Type: application/json)");
    const raw = await readRaw(req, MAX_BODY);
    try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { throw httpError(400, "Invalid JSON"); }
  };

  async function serveStatic(req, res, pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    if (rel.includes("..")) return send(res, 400, "Bad request");
    let file = join(PUBLIC, rel || "index.html");
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      if (extname(rel)) return send(res, 404, "Not found", { "Content-Type": TYPES[".txt"] });
      file = join(PUBLIC, "index.html");
      info = await stat(file);
    }
    const etag = `W/"${createHash("sha1").update(`${file}:${info.size}:${info.mtimeMs}`).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) return send(res, 304, null, { ETag: etag });
    send(res, 200, req.method === "HEAD" ? null : await readFile(file), {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", ETag: etag });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const q = url.searchParams;
    const m = (re) => re.exec(p);
    let match;

    // --- public routes

    if (p === "/api/health" && req.method === "GET") {
      const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM intents) AS intents,
        (SELECT COUNT(*) FROM sync_jobs WHERE state = 'queued') AS queued, (SELECT MAX(last_synced_at) FROM branches) AS lastSync,
        (SELECT COUNT(*) FROM branches WHERE sync_error IS NOT NULL) AS syncErrors`).get();
      return json(res, 200, { status: "healthy", parserVersion: PARSER_VERSION, aidlcCheckedAgainst: AIDLC_CHECKED_AGAINST,
        allowLocal, github: Boolean(appRow()), ...counts, githubRateRemaining: client?.rate.remaining ?? null,
        uptime: Math.round((Date.now() - started) / 1000) });
    }

    if (p === "/api/webhooks/github" && req.method === "POST") {
      const raw = await readRaw(req, MAX_WEBHOOK_BODY);
      const result = handleGithubWebhook(ctx, { event: req.headers["x-github-event"], delivery: req.headers["x-github-delivery"],
        signature: req.headers["x-hub-signature-256"], raw });
      if (result.status === 202) kick();
      return json(res, result.status, result.body);
    }

    if (p === "/auth/github/login" && req.method === "GET") {
      const c = github();
      if (!c) return redirect(res, "/#/connections");
      return redirect(res, c.authorizeUrl({ state: newState(db, "signin"), redirectUri: `${base}/auth/github/callback` }));
    }
    if (p === "/auth/github/callback" && req.method === "GET") {
      const c = github();
      if (!c || !takeState(db, q.get("state"), "signin")) return redirect(res, "/#/signin?error=state");
      if (!q.get("code")) return redirect(res, "/#/signin?error=denied");
      try {
        const { access_token: token } = await c.exchangeCode(q.get("code"), `${base}/auth/github/callback`);
        const user = await c.currentUser(token);
        const repoIds = await c.userRepoIds(token);
        const raw = createSession(db, key, { user, token, repoIds });
        return redirect(res, "/#/", { "Set-Cookie": sessionCookie(raw, { secure: secureCookies }) });
      } catch (err) {
        log(`Sign-in failed: ${err.message}`);
        return redirect(res, "/#/signin?error=failed");
      }
    }

    const session = await currentSession(ctx, req);

    if (p === "/api/me" && req.method === "GET") {
      const row = appRow();
      return json(res, 200, {
        signedIn: Boolean(session), authRequired: authRequired(), user: session ? { login: session.login, name: session.name, avatarUrl: session.avatarUrl } : null,
        github: row ? { configured: true, name: row.name, slug: row.slug, owner: row.owner, appUrl: row.html_url, installUrl: `${row.html_url}/installations/new` }
          : { configured: false, canSetUp: Boolean(setupAllowed(req)), webhooks: !publicIsLocal },
        allowLocal,
      });
    }
    if (p === "/api/auth/signout" && req.method === "POST") {
      await readJson(req);
      deleteSession(db, session?.raw);
      return json(res, 200, { signedOut: true }, { "Set-Cookie": sessionCookie("", { secure: secureCookies, clear: true }) });
    }

    // GitHub app setup: allowed only before an app exists, from this computer or with the setup token.
    if (p === "/api/github/manifest" && req.method === "POST") {
      if (appRow()) throw httpError(409, "GitHub is already set up");
      if (!setupAllowed(req)) throw httpError(403, "Set up GitHub from the computer running the tracker, or send the setup token");
      const body = await readJson(req);
      const org = typeof body.org === "string" ? body.org.trim() : "";
      if (org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) throw httpError(400, "Not a valid organisation name");
      const state = newState(db, "manifest");
      const target = org ? `${githubWebUrl}/organizations/${org}/settings/apps/new` : `${githubWebUrl}/settings/apps/new`;
      return json(res, 200, { action: `${target}?state=${encodeURIComponent(state)}`, manifest: manifest(`AI-DLC Tracker ${randomToken(3)}`) });
    }
    if (p === "/api/github/manifest/callback" && req.method === "GET") {
      if (appRow()) return redirect(res, "/#/connections");
      if (!takeState(db, q.get("state"), "manifest") || !q.get("code")) return redirect(res, "/#/connections?error=setup");
      const app = await bareGithub().convertManifest(q.get("code"));
      db.prepare(`INSERT INTO github_app (id, app_id, slug, name, owner, html_url, client_id, client_secret_enc, webhook_secret_enc, pem_enc)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(app.id), app.slug, app.name, app.owner?.login ?? null, app.html_url,
        app.client_id, encrypt(key, app.client_secret), app.webhook_secret ? encrypt(key, app.webhook_secret) : null, encrypt(key, app.pem));
      log(`GitHub app ${app.slug} set up`);
      return redirect(res, `${app.html_url}/installations/new`);
    }
    if (p === "/api/github/installed" && req.method === "GET") {
      const c = github();
      const id = q.get("installation_id");
      if (c && /^\d+$/.test(id ?? "")) {
        try {
          const inst = await c.getInstallation(id); // only succeeds for installations of this app
          enqueueBackfill(db, upsertInstallation(db, { installationId: inst.id, account: inst.account?.login ?? null }), "installed");
          kick();
        } catch (err) { log(`Installation ${id} not recorded: ${err.message}`); }
      }
      return redirect(res, session || !authRequired() ? "/#/connections" : "/auth/github/login");
    }

    // --- everything below needs sign-in once GitHub is set up

    if (p.startsWith("/api/")) {
      if (authRequired() && !session) return json(res, 401, { error: "Sign in to continue", signIn: "/auth/github/login" });
      const vis = visibleRepoIds(session);
      const repoFor = (id) => {
        const repo = db.prepare("SELECT r.id, c.platform FROM repos r JOIN connections c ON c.id = r.connection_id WHERE r.id = ?").get(id);
        if (!repo || !canSee(vis, repo.id)) throw httpError(404, "No such repo");
        return repo;
      };

      if (p === "/api/repos" && req.method === "GET") return json(res, 200, repoList(vis));
      if (p === "/api/repos" && req.method === "POST") {
        if (!allowLocal) throw httpError(403, "Adding local folders is turned off on this server");
        const body = await readJson(req);
        if (typeof body.path !== "string" || !body.path.trim()) throw httpError(400, "path is required");
        const { repo, branch, created } = addLocalRepo(db, body.path.trim());
        enqueue(db, branch.id, "added");
        await kick(); await idle();
        return json(res, created ? 201 : 200, repoList(null).find((r) => r.id === repo.id));
      }
      if ((match = m(/^\/api\/repos\/(\d+)$/)) && req.method === "DELETE") {
        const repo = repoFor(Number(match[1]));
        if (repo.platform !== "local") throw httpError(400, "Remove GitHub repos from the app's installation settings on GitHub");
        removeRepo(db, repo.id);
        return json(res, 200, { removed: repo.id });
      }
      if ((match = m(/^\/api\/repos\/(\d+)\/resync$/)) && req.method === "POST") {
        await readJson(req);
        const repo = repoFor(Number(match[1]));
        const jobs = new Set(db.prepare("SELECT id FROM branches WHERE repo_id = ?").all(repo.id).map((b) => enqueue(db, b.id, "resync")));
        const results = (await kick()).filter((r) => jobs.has(r.job));
        await idle();
        return json(res, 200, { results, repo: repoList(vis).find((r) => r.id === repo.id) });
      }
      if ((match = m(/^\/api\/repos\/(\d+)\/branches$/)) && req.method === "POST") {
        const repo = repoFor(Number(match[1]));
        const body = await readJson(req);
        const { id, created } = addBranch(db, repo.id, body.name);
        enqueue(db, id, "added");
        await kick(); await idle();
        return json(res, created ? 201 : 200, { repo: repoList(vis).find((r) => r.id === repo.id) });
      }
      if ((match = m(/^\/api\/repos\/(\d+)\/branches\/(\d+)$/)) && req.method === "DELETE") {
        const repo = repoFor(Number(match[1]));
        if (!removeBranch(db, repo.id, Number(match[2]))) throw httpError(404, "No such branch");
        return json(res, 200, { repo: repoList(vis).find((r) => r.id === repo.id) });
      }
      if (p === "/api/github/reconcile" && req.method === "POST") {
        await readJson(req);
        if (!appRow()) throw httpError(400, "GitHub is not set up");
        await reconcileGithub(); await idle();
        return json(res, 200, { repos: repoList(vis) });
      }
      if (p === "/api/intents" && req.method === "GET") return json(res, 200, listIntents(q, vis));
      if ((match = m(/^\/api\/intents\/(\d+)$/)) && req.method === "GET") return json(res, 200, getIntent(Number(match[1]), vis));
      if (p === "/api/questions" && req.method === "GET") {
        if (q.get("open") === "false") throw httpError(400, "Only open=true is supported; answered questions are on each intent");
        return json(res, 200, inbox(q, vis));
      }
      return json(res, 404, { error: "Unknown API route" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, p);
  }

  const server = createServer(async (req, res) => {
    const t = Date.now();
    try { await handle(req, res); }
    catch (err) {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.status ? err.message : "Internal server error" });
      if (!err.status) log(err.stack ?? String(err));
    } finally {
      if (req.url.startsWith("/api/") && req.url !== "/api/health") log(`${req.method} ${req.url.split("?")[0]} ${res.statusCode} ${Date.now() - t}ms`);
    }
  });

  const close = async () => {
    for (const t of timers) clearInterval(t);
    await ready.catch(() => {});
    await idle();
    await new Promise((r) => server.close(r));
    db.close();
  };
  return { server, db, ready, idle, kick, close };
}
