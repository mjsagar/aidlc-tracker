// HTTP app: JSON API plus the static screens in public/.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.mjs";
import { addLocalRepo, enqueue, enqueueAll, removeRepo, runAllJobs } from "./sync.mjs";
import { PARSER_VERSION, AIDLC_CHECKED_AGAINST } from "./version.mjs";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
const MAX_BODY = 16 * 1024;
const STALE_DAYS = 7;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {{dbPath?: string, allowLocal?: boolean, pollSeconds?: number, localRepos?: string[], log?: (s: string) => void}} opts
 */
export function createApp({ dbPath = ":memory:", allowLocal = true, pollSeconds = 30, localRepos = [], log = () => {} } = {}) {
  const db = openDb(dbPath);
  const started = Date.now();

  for (const path of localRepos) {
    try { addLocalRepo(db, path); } catch (err) { log(`Could not add ${path}: ${err.message}`); }
  }
  enqueueAll(db, "startup");
  runAllJobs(db);

  let poller = null;
  if (pollSeconds > 0) {
    poller = setInterval(() => {
      try { enqueueAll(db, "poll"); runAllJobs(db); } catch (err) { log(`Poll failed: ${err.message}`); }
    }, pollSeconds * 1000);
    poller.unref();
  }

  // ---------- queries

  const repoRows = () => db.prepare(`
    SELECT r.id, r.full_name AS name, r.local_path AS path, r.web_url AS webUrl, r.aidlc_version AS aidlcVersion, c.platform,
      b.id AS branchId, b.name AS branch, b.last_commit_sha AS commitSha, b.last_synced_at AS lastSyncedAt, b.sync_error AS syncError,
      (SELECT COUNT(*) FROM intents i WHERE i.branch_id = b.id) AS intents,
      (SELECT COALESCE(SUM(open_questions), 0) FROM intents i WHERE i.branch_id = b.id) AS openQuestions,
      (SELECT COALESCE(SUM(waiting), 0) FROM intents i WHERE i.branch_id = b.id) AS waiting
    FROM repos r JOIN connections c ON c.id = r.connection_id JOIN branches b ON b.repo_id = r.id
    ORDER BY r.full_name, b.name`).all();

  const intentBase = `
    SELECT i.*, r.id AS repo_id, r.full_name AS repo_name, r.web_url AS repo_url, b.name AS branch_name
    FROM intents i JOIN branches b ON b.id = i.branch_id JOIN repos r ON r.id = b.repo_id`;

  const openQuestionRows = db.prepare(`
    SELECT q.*, i.id AS intent_row FROM questions q JOIN intents i ON i.id = q.intent_id WHERE q.open = 1`);

  // When something on this intent started waiting on a person: oldest of its blockers and open questions.
  const waitingSince = (snapshot, questions) => {
    const times = [...snapshot.blockers.map((b) => b.since), ...questions.map((q) => q.open_since ?? q.first_seen_open)]
      .map((t) => Date.parse(t ?? "")).filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)).toISOString().replace(/\.000Z$/, "Z") : null;
  };

  const intentSummary = (row, openQs) => {
    const snapshot = JSON.parse(row.snapshot_json);
    return {
      id: row.id,
      key: `${row.space}/${row.folder}`,
      label: snapshot.label,
      repo: { id: row.repo_id, name: row.repo_name, url: row.repo_url },
      branch: row.branch_name,
      description: row.description,
      scope: row.scope,
      phase: row.phase,
      stage: row.stage,
      status: row.status,
      done: row.done,
      total: row.total,
      openQuestions: row.open_questions,
      waiting: row.waiting,
      waitingSince: waitingSince(snapshot, openQs),
      lastActivity: row.last_activity,
      createdOn: snapshot.createdOn,
      warnings: row.warnings,
      phases: snapshot.phases,
    };
  };

  function listIntents(params) {
    const rows = db.prepare(`${intentBase} ORDER BY r.full_name, i.space, i.folder`).all();
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

  function getIntent(id) {
    const row = db.prepare(`${intentBase} WHERE i.id = ?`).get(id);
    if (!row) throw httpError(404, "No such piece of work");
    const snapshot = JSON.parse(row.snapshot_json);
    const questions = db.prepare("SELECT * FROM questions WHERE intent_id = ? ORDER BY file, line").all(id).map((q) => {
      const parsed = snapshot.questions.find((p) => p.file === q.file && p.line === q.line) ?? {};
      return {
        kind: q.kind, number: q.number, trade: q.trade, title: q.title, prompt: parsed.prompt ?? "", options: parsed.options ?? [],
        multiSelect: parsed.multiSelect ?? false, answer: q.answer, open: !!q.open, file: q.file, line: q.answer_line ?? q.line,
        phase: q.phase, stage: q.stage, unit: q.unit, openSince: q.open_since ?? q.first_seen_open, answeredAt: q.answered_at,
      };
    });
    const events = db.prepare("SELECT * FROM events WHERE intent_id = ? ORDER BY timestamp IS NULL, timestamp, shard, idx").all(id)
      .map((e) => ({ timestamp: e.timestamp, event: e.event, known: !!e.known, stage: e.stage, unit: e.unit, gitName: e.git_name,
        shard: e.shard, fields: JSON.parse(e.fields_json) }));
    const openQs = db.prepare("SELECT * FROM questions WHERE intent_id = ? AND open = 1").all(id);
    return {
      ...intentSummary(row, openQs),
      path: snapshot.path,
      project: snapshot.project,
      current: snapshot.current,
      stages: snapshot.stages,
      progress: snapshot.progress,
      blockers: snapshot.blockers,
      approvals: snapshot.approvals,
      notes: snapshot.notes,
      warningList: snapshot.warnings,
      questions,
      events,
      parserVersion: row.parser_version,
      syncedAt: row.updated_at,
    };
  }

  function inbox(params) {
    const intents = db.prepare(intentBase).all();
    const byId = new Map(intents.map((r) => [r.id, r]));
    const items = [];
    for (const r of intents) {
      const snapshot = JSON.parse(r.snapshot_json);
      for (const b of snapshot.blockers) {
        items.push({ type: b.type, intent: r.id, repo: { id: r.repo_id, name: r.repo_name }, key: `${r.space}/${r.folder}`,
          description: r.description, phase: b.phase, stage: b.stage, unit: b.unit, trade: null, since: b.since,
          revisionCount: b.revisionCount, title: null, file: `${snapshot.path}/aidlc-state.md`, line: null });
      }
    }
    for (const q of openQuestionRows.all()) {
      const r = byId.get(q.intent_row);
      items.push({ type: q.kind, intent: r.id, repo: { id: r.repo_id, name: r.repo_name }, key: `${r.space}/${r.folder}`,
        description: r.description, phase: q.phase, stage: q.stage, unit: q.unit, trade: q.trade, since: q.open_since ?? q.first_seen_open,
        number: q.number, title: q.title, file: q.file, line: q.answer_line ?? q.line });
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

  // ---------- HTTP

  const send = (res, status, body, headers = {}) => { res.writeHead(status, { ...SECURITY, ...headers }); res.end(body); };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });

  const readJson = (req) => new Promise((resolve, reject) => {
    // Requiring application/json makes a cross-site form post impossible: browsers preflight it and we send no CORS headers.
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reject(httpError(415, "Send JSON (Content-Type: application/json)"));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(httpError(413, "Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(httpError(400, "Invalid JSON")); } });
    req.on("error", reject);
  });

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
    const m = (re) => re.exec(p);
    let match;

    if (p === "/api/health" && req.method === "GET") {
      const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM intents) AS intents,
        (SELECT COUNT(*) FROM sync_jobs WHERE state = 'queued') AS queued, (SELECT MAX(last_synced_at) FROM branches) AS lastSync,
        (SELECT COUNT(*) FROM branches WHERE sync_error IS NOT NULL) AS syncErrors`).get();
      return json(res, 200, { status: "healthy", parserVersion: PARSER_VERSION, aidlcCheckedAgainst: AIDLC_CHECKED_AGAINST,
        allowLocal, ...counts, uptime: Math.round((Date.now() - started) / 1000) });
    }
    if (p === "/api/repos" && req.method === "GET") return json(res, 200, repoRows());
    if (p === "/api/repos" && req.method === "POST") {
      if (!allowLocal) throw httpError(403, "Adding local folders is turned off on this server");
      const body = await readJson(req);
      if (typeof body.path !== "string" || !body.path.trim()) throw httpError(400, "path is required");
      const { branch, created } = addLocalRepo(db, body.path.trim());
      enqueue(db, branch.id, "added");
      runAllJobs(db);
      return json(res, created ? 201 : 200, repoRows().find((r) => r.branchId === branch.id));
    }
    if ((match = m(/^\/api\/repos\/(\d+)$/)) && req.method === "DELETE") {
      if (!removeRepo(db, Number(match[1]))) throw httpError(404, "No such repo");
      return json(res, 200, { removed: Number(match[1]) });
    }
    if ((match = m(/^\/api\/repos\/(\d+)\/resync$/)) && req.method === "POST") {
      await readJson(req);
      const branches = db.prepare("SELECT id FROM branches WHERE repo_id = ?").all(Number(match[1]));
      if (!branches.length) throw httpError(404, "No such repo");
      for (const b of branches) enqueue(db, b.id, "resync");
      const results = runAllJobs(db);
      return json(res, 200, { results, repo: repoRows().find((r) => r.id === Number(match[1])) });
    }
    if (p === "/api/intents" && req.method === "GET") return json(res, 200, listIntents(url.searchParams));
    if ((match = m(/^\/api\/intents\/(\d+)$/)) && req.method === "GET") return json(res, 200, getIntent(Number(match[1])));
    if (p === "/api/questions" && req.method === "GET") {
      if (url.searchParams.get("open") === "false") throw httpError(400, "Only open=true is supported; answered questions are on each intent");
      return json(res, 200, inbox(url.searchParams));
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "Unknown API route" });
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
      if (req.url.startsWith("/api/") && req.url !== "/api/health") log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms`);
    }
  });

  const close = () => new Promise((r) => { if (poller) clearInterval(poller); server.close(() => { db.close(); r(); }); });
  return { server, db, close };
}
