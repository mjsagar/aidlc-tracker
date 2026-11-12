// Sync engine: reads a repo's AI-DLC records, parses them, and replaces that
// branch's rows. Jobs go through the `sync_jobs` table so webhooks (milestone 3)
// and the local poller share one path.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tx } from "./db.mjs";
import { readLocalRepo } from "./source/local.mjs";
import { readGithubBranch } from "./source/github.mjs";
import { parseRepo } from "./parse/repo.mjs";
import { PARSER_VERSION } from "./version.mjs";

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Current branch and commit of a local checkout, read from .git without running git. */
export function localGitInfo(root) {
  try {
    let gitDir = join(root, ".git");
    if (!existsSync(gitDir)) return { branch: null, sha: null };
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return { branch: null, sha: null };
      gitDir = resolve(root, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return { branch: null, sha: /^[0-9a-f]{40}$/.test(head) ? head : null };
    const branch = ref.replace(/^refs\/heads\//, "");
    let sha = null;
    const loose = join(gitDir, ref);
    if (existsSync(loose)) sha = readFileSync(loose, "utf8").trim();
    else {
      const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
      const packed = join(common, "packed-refs");
      const looseCommon = join(common, ref);
      if (existsSync(looseCommon)) sha = readFileSync(looseCommon, "utf8").trim();
      else if (existsSync(packed)) sha = readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
    }
    return { branch, sha };
  } catch {
    return { branch: null, sha: null };
  }
}

/** Hash of the tracked files: the local stand-in for the `aidlc/` subtree SHA. */
export function contentHash(files) {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) h.update(path).update("\0").update(files.get(path)).update("\0");
  return h.digest("hex");
}

function localConnection(db) {
  const row = db.prepare("SELECT id FROM connections WHERE platform = 'local' ORDER BY id LIMIT 1").get();
  if (row) return row.id;
  const ws = db.prepare("SELECT id FROM workspaces ORDER BY id LIMIT 1").get();
  return Number(db.prepare("INSERT INTO connections (workspace_id, platform, account) VALUES (?, 'local', 'this machine')").run(ws.id).lastInsertRowid);
}

/**
 * Adds a local checkout. Returns {repo, branch, created}.
 * Throws {status: 400} for a path that is not a folder.
 */
export function addLocalRepo(db, path) {
  const root = resolve(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw Object.assign(new Error(`Not a folder: ${path}`), { status: 400 });
  const connectionId = localConnection(db);
  const existing = db.prepare("SELECT * FROM repos WHERE connection_id = ? AND platform_repo_id = ?").get(connectionId, root);
  if (existing) {
    const branch = db.prepare("SELECT * FROM branches WHERE repo_id = ? ORDER BY id LIMIT 1").get(existing.id);
    return { repo: existing, branch, created: false };
  }
  const git = localGitInfo(root);
  return tx(db, () => {
    const repoId = Number(db.prepare(
      "INSERT INTO repos (connection_id, platform_repo_id, full_name, local_path, default_branch) VALUES (?, ?, ?, ?, ?)",
    ).run(connectionId, root, basename(root), root, git.branch).lastInsertRowid);
    const branchId = Number(db.prepare("INSERT INTO branches (repo_id, name) VALUES (?, ?)").run(repoId, git.branch ?? "working tree").lastInsertRowid);
    return {
      repo: db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId),
      branch: db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId),
      created: true,
    };
  });
}

/** Deletes cached file contents no tracked branch refers to any more. */
export function pruneBlobs(db) {
  return db.prepare("DELETE FROM blobs WHERE sha NOT IN (SELECT sha FROM files)").run().changes;
}

export function removeRepo(db, repoId) {
  const removed = db.prepare("DELETE FROM repos WHERE id = ?").run(repoId).changes > 0;
  pruneBlobs(db);
  return removed;
}

/** Queues a sync unless one is already queued for that branch. Returns the job id. */
export function enqueue(db, branchId, reason) {
  const queued = db.prepare("SELECT id FROM sync_jobs WHERE branch_id = ? AND state = 'queued'").get(branchId);
  if (queued) return queued.id;
  return Number(db.prepare("INSERT INTO sync_jobs (branch_id, reason) VALUES (?, ?)").run(branchId, reason).lastInsertRowid);
}

/** Queues every tracked branch, optionally only those on one platform. */
export function enqueueAll(db, reason, { platform } = {}) {
  const rows = db.prepare(`SELECT b.id FROM branches b JOIN repos r ON r.id = b.repo_id JOIN connections c ON c.id = r.connection_id
    WHERE b.tracked = 1 AND r.tracked = 1 AND (? IS NULL OR c.platform = ?)`).all(platform ?? null, platform ?? null);
  return rows.map((r) => enqueue(db, r.id, reason));
}

// ---------- GitHub installations

/** Records a GitHub App installation as a connection. Returns the connection id. */
export function upsertInstallation(db, { installationId, account }) {
  const existing = db.prepare("SELECT id FROM connections WHERE platform = 'github' AND external_id = ?").get(String(installationId));
  if (existing) {
    db.prepare("UPDATE connections SET account = ? WHERE id = ?").run(account, existing.id);
    return existing.id;
  }
  const ws = db.prepare("SELECT id FROM workspaces ORDER BY id LIMIT 1").get();
  return Number(db.prepare("INSERT INTO connections (workspace_id, platform, host, account, external_id) VALUES (?, 'github', 'github.com', ?, ?)")
    .run(ws.id, account, String(installationId)).lastInsertRowid);
}

export function removeInstallation(db, installationId) {
  const removed = db.prepare("DELETE FROM connections WHERE platform = 'github' AND external_id = ?").run(String(installationId)).changes > 0;
  pruneBlobs(db);
  return removed;
}

export function enqueueBackfill(db, connectionId, reason) {
  const queued = db.prepare("SELECT id FROM connection_jobs WHERE connection_id = ? AND state = 'queued'").get(connectionId);
  if (queued) return queued.id;
  return Number(db.prepare("INSERT INTO connection_jobs (connection_id, reason) VALUES (?, ?)").run(connectionId, reason).lastInsertRowid);
}

/** Lists the installation's repos; adds new ones with their default branch tracked, removes ones no longer granted. */
async function backfill(ctx, connectionId) {
  const { db } = ctx;
  const client = ctx.github();
  if (!client) throw new Error("GitHub is not set up");
  const conn = db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId);
  if (!conn) return { repos: 0 };
  const repos = await client.installationRepos(conn.external_id);
  const ids = new Set(repos.map((r) => String(r.id)));
  tx(db, () => {
    for (const r of repos) {
      db.prepare(`INSERT INTO repos (connection_id, platform_repo_id, full_name, default_branch, web_url) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (connection_id, platform_repo_id) DO UPDATE SET full_name = excluded.full_name, default_branch = excluded.default_branch, web_url = excluded.web_url`)
        .run(connectionId, String(r.id), r.full_name, r.default_branch, r.html_url);
      const repo = db.prepare("SELECT id FROM repos WHERE connection_id = ? AND platform_repo_id = ?").get(connectionId, String(r.id));
      if (!db.prepare("SELECT 1 FROM branches WHERE repo_id = ?").get(repo.id)) {
        db.prepare("INSERT INTO branches (repo_id, name) VALUES (?, ?)").run(repo.id, r.default_branch);
      }
    }
    for (const row of db.prepare("SELECT id, platform_repo_id FROM repos WHERE connection_id = ?").all(connectionId)) {
      if (!ids.has(row.platform_repo_id)) db.prepare("DELETE FROM repos WHERE id = ?").run(row.id);
    }
    pruneBlobs(db);
  });
  for (const b of db.prepare(`SELECT b.id FROM branches b JOIN repos r ON r.id = b.repo_id
    WHERE r.connection_id = ? AND b.tracked = 1 AND r.tracked = 1`).all(connectionId)) enqueue(db, b.id, "backfill");
  return { repos: repos.length };
}

// ---------- branches people choose to track

export function addBranch(db, repoId, name) {
  const clean = String(name ?? "").trim();
  if (!clean || clean.length > 255 || /\s|\.\.|^[-/]|[~^:?*[\\]/.test(clean)) throw Object.assign(new Error("Not a valid branch name"), { status: 400 });
  const repo = db.prepare("SELECT r.id, c.platform FROM repos r JOIN connections c ON c.id = r.connection_id WHERE r.id = ?").get(repoId);
  if (!repo) throw Object.assign(new Error("No such repo"), { status: 404 });
  if (repo.platform === "local") throw Object.assign(new Error("A local folder tracks whichever branch is checked out"), { status: 400 });
  const existing = db.prepare("SELECT id FROM branches WHERE repo_id = ? AND name = ?").get(repoId, clean);
  if (existing) return { id: existing.id, created: false };
  return { id: Number(db.prepare("INSERT INTO branches (repo_id, name) VALUES (?, ?)").run(repoId, clean).lastInsertRowid), created: true };
}

export function removeBranch(db, repoId, branchId) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM branches WHERE repo_id = ?").get(repoId).n;
  if (count <= 1) throw Object.assign(new Error("A repo needs at least one tracked branch; remove the repo instead"), { status: 400 });
  const removed = db.prepare("DELETE FROM branches WHERE id = ? AND repo_id = ?").run(branchId, repoId).changes > 0;
  pruneBlobs(db);
  return removed;
}

// ---------- job runner

/** Runs the oldest due job (installation backfills first). Returns its result, or null when nothing is due. */
export async function runNextJob(ctx) {
  const { db } = ctx;
  const cjob = db.prepare("SELECT * FROM connection_jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get();
  if (cjob) {
    db.prepare("UPDATE connection_jobs SET state = 'running' WHERE id = ?").run(cjob.id);
    try {
      const result = await backfill(ctx, cjob.connection_id);
      db.prepare("UPDATE connection_jobs SET state = 'done', finished_at = ? WHERE id = ?").run(nowIso(), cjob.id);
      return { connectionJob: cjob.id, ...result };
    } catch (err) {
      db.prepare("UPDATE connection_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(err.message), nowIso(), cjob.id);
      ctx.log?.(`Backfill ${cjob.connection_id} failed: ${err.message}`);
      return { connectionJob: cjob.id, error: err.message };
    }
  }

  const job = db.prepare("SELECT * FROM sync_jobs WHERE state = 'queued' AND (run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT 1").get(new Date().toISOString());
  if (!job) return null;
  db.prepare("UPDATE sync_jobs SET state = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
  try {
    const result = await syncBranch(ctx, job.branch_id, { force: job.reason === "resync" });
    db.prepare("UPDATE sync_jobs SET state = 'done', finished_at = ? WHERE id = ?").run(nowIso(), job.id);
    return { job: job.id, ...result };
  } catch (err) {
    if (err.retryAfter != null && job.attempts < 5) {
      // Rate limited: put it back until GitHub says to retry.
      db.prepare("UPDATE sync_jobs SET state = 'queued', run_after = ? WHERE id = ?").run(new Date(Date.now() + err.retryAfter + 1000).toISOString(), job.id);
      return { job: job.id, deferred: true, error: err.message };
    }
    db.prepare("UPDATE sync_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(err.message), nowIso(), job.id);
    if (db.prepare("SELECT 1 FROM branches WHERE id = ?").get(job.branch_id)) {
      db.prepare("UPDATE branches SET sync_error = ?, last_synced_at = ? WHERE id = ?").run(String(err.message), nowIso(), job.branch_id);
    }
    return { job: job.id, error: err.message };
  }
}

/** Runs every due job, including the ones a backfill queues. */
export async function runAllJobs(ctx) {
  const results = [];
  for (let r = await runNextJob(ctx); r; r = await runNextJob(ctx)) results.push(r);
  const week = new Date(Date.now() - 7 * 864e5).toISOString();
  ctx.db.prepare("DELETE FROM sync_jobs WHERE state IN ('done','failed') AND finished_at < ?").run(week);
  ctx.db.prepare("DELETE FROM connection_jobs WHERE state IN ('done','failed') AND finished_at < ?").run(week);
  return results;
}

// ---------- reading one branch

/**
 * Reads and stores one branch. Skips the write when nothing under aidlc/ changed, unless `force`.
 */
export async function syncBranch(ctx, branchId, { force = false } = {}) {
  const { db } = ctx;
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId);
  if (!branch) throw new Error(`No branch ${branchId}`);
  const repo = db.prepare("SELECT r.*, c.platform, c.external_id FROM repos r JOIN connections c ON c.id = r.connection_id WHERE r.id = ?").get(branch.repo_id);
  if (repo.platform === "github") return syncGithubBranch(ctx, repo, branch, { force: force || Boolean(branch.sync_error) });
  if (repo.platform !== "local") throw new Error(`${repo.platform} repos are not supported yet`);
  if (!existsSync(repo.local_path)) throw new Error(`Folder no longer exists: ${repo.local_path}`);

  const { files, skipped } = readLocalRepo(repo.local_path);
  const git = localGitInfo(repo.local_path);
  const hash = contentHash(files);
  const at = nowIso();
  if (!force && hash === branch.last_tree_sha && !branch.sync_error) {
    db.prepare("UPDATE branches SET last_synced_at = ?, last_commit_sha = ? WHERE id = ?").run(at, git.sha, branchId);
    return { changed: false, intents: null, skipped };
  }
  const snapshot = parseRepo(files);
  tx(db, () => {
    writeSnapshot(db, branchId, snapshot, at);
    db.prepare("UPDATE repos SET aidlc_version = ?, default_branch = COALESCE(?, default_branch) WHERE id = ?").run(snapshot.aidlcVersion, git.branch, repo.id);
    db.prepare("UPDATE branches SET name = ?, last_commit_sha = ?, last_tree_sha = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?")
      .run(git.branch ?? branch.name, git.sha, hash, at, branchId);
  });
  return { changed: true, intents: snapshot.intents.length, skipped };
}

async function syncGithubBranch(ctx, repo, branch, { force }) {
  const { db } = ctx;
  const client = ctx.github();
  if (!client) throw new Error("GitHub is not set up");
  const getBlob = (sha) => db.prepare("SELECT content FROM blobs WHERE sha = ?").get(sha)?.content;
  const read = await readGithubBranch(client, {
    installationId: repo.external_id, fullName: repo.full_name, branch: branch.name, lastTreeKey: branch.last_tree_sha, force, getBlob,
  });
  const at = nowIso();
  if (read.unchanged) {
    db.prepare("UPDATE branches SET last_synced_at = ?, last_commit_sha = ? WHERE id = ?").run(at, read.commitSha, branch.id);
    return { changed: false, intents: null, skipped: [] };
  }
  const files = new Map(read.entries.map((e) => [e.path, e.content]));
  const snapshot = parseRepo(files);
  tx(db, () => {
    const putBlob = db.prepare("INSERT OR IGNORE INTO blobs (sha, content) VALUES (?, ?)");
    for (const e of read.entries) if (e.fetched) putBlob.run(e.sha, e.content);
    db.prepare("DELETE FROM files WHERE branch_id = ?").run(branch.id);
    const putFile = db.prepare("INSERT INTO files (branch_id, path, sha) VALUES (?, ?, ?)");
    for (const e of read.entries) putFile.run(branch.id, e.path, e.sha);
    pruneBlobs(db);
    writeSnapshot(db, branch.id, snapshot, at);
    db.prepare("UPDATE repos SET aidlc_version = ? WHERE id = ?").run(snapshot.aidlcVersion, repo.id);
    db.prepare("UPDATE branches SET last_commit_sha = ?, last_tree_sha = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?")
      .run(read.commitSha, read.treeKey, at, branch.id);
  });
  return { changed: true, intents: snapshot.intents.length, skipped: read.skipped, fetched: read.entries.filter((e) => e.fetched).length };
}

const qkey = (q) => `${q.file}#${q.kind === "summary" ? "summary" : q.number != null ? `Q${q.number}` : `L${q.line}`}`;

function writeSnapshot(db, branchId, snapshot, at) {
  const existing = new Map(db.prepare("SELECT id, space, folder FROM intents WHERE branch_id = ?").all(branchId).map((r) => [`${r.space}/${r.folder}`, r.id]));
  const upsertIntent = db.prepare(`
    INSERT INTO intents (branch_id, space, folder, description, scope, phase, stage, status, done, total, open_questions, waiting,
      last_activity, warnings, snapshot_json, parser_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (branch_id, space, folder) DO UPDATE SET description = excluded.description, scope = excluded.scope,
      phase = excluded.phase, stage = excluded.stage, status = excluded.status, done = excluded.done, total = excluded.total,
      open_questions = excluded.open_questions, waiting = excluded.waiting, last_activity = excluded.last_activity,
      warnings = excluded.warnings, snapshot_json = excluded.snapshot_json, parser_version = excluded.parser_version,
      updated_at = excluded.updated_at
    RETURNING id`);
  const priorQuestions = db.prepare("SELECT qkey, open, first_seen_open, answered_at FROM questions WHERE intent_id = ?");
  const deleteQuestions = db.prepare("DELETE FROM questions WHERE intent_id = ?");
  const insertQuestion = db.prepare(`
    INSERT INTO questions (intent_id, qkey, file, kind, number, trade, title, phase, stage, unit, line, answer_line, answer, open,
      open_since, first_seen_open, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteEvents = db.prepare("DELETE FROM events WHERE intent_id = ?");
  const insertEvent = db.prepare(`INSERT INTO events (intent_id, shard, idx, timestamp, event, known, stage, unit, git_name, fields_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const seen = new Set();
  for (const intent of snapshot.intents) {
    seen.add(intent.id);
    const { events, ...rest } = intent;
    const { id } = upsertIntent.get(branchId, intent.space, intent.folder, intent.description, intent.project?.scope ?? null,
      intent.current?.phase ?? null, intent.current?.stage ?? null, intent.current?.status ?? null, intent.progress.done,
      intent.progress.total, intent.openQuestionCount, intent.blockers.length, intent.lastActivity, intent.warnings.length,
      JSON.stringify(rest), PARSER_VERSION, at);

    const prior = new Map(priorQuestions.all(id).map((r) => [r.qkey, r]));
    deleteQuestions.run(id);
    for (const q of intent.questions) {
      const key = qkey(q);
      const before = prior.get(key);
      const firstSeenOpen = q.open ? before?.first_seen_open ?? at : before?.first_seen_open ?? null;
      const answeredAt = q.open ? null : q.answeredAt ?? before?.answered_at ?? (before?.open ? at : null);
      insertQuestion.run(id, key, q.file, q.kind, q.number, q.trade, q.title, q.phase, q.stage, q.unit, q.line, q.answerLine,
        q.answer, q.open ? 1 : 0, q.openSince, firstSeenOpen, answeredAt);
    }

    deleteEvents.run(id);
    for (const e of events) {
      insertEvent.run(id, e.shard, e.index, e.timestamp, e.event, e.known ? 1 : 0, e.stage, e.unit, e.gitName, JSON.stringify(e.fields));
    }
  }
  for (const [key, id] of existing) if (!seen.has(key)) db.prepare("DELETE FROM intents WHERE id = ?").run(id);
}
