// Sync engine: reads a repo's AI-DLC records, parses them, and replaces that
// branch's rows. Jobs go through the `sync_jobs` table so webhooks (milestone 3)
// and the local poller share one path.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tx } from "./db.mjs";
import { readLocalRepo } from "./source/local.mjs";
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

export function removeRepo(db, repoId) {
  return db.prepare("DELETE FROM repos WHERE id = ?").run(repoId).changes > 0;
}

/** Queues a sync unless one is already queued for that branch. Returns the job id. */
export function enqueue(db, branchId, reason) {
  const queued = db.prepare("SELECT id FROM sync_jobs WHERE branch_id = ? AND state = 'queued'").get(branchId);
  if (queued) return queued.id;
  return Number(db.prepare("INSERT INTO sync_jobs (branch_id, reason) VALUES (?, ?)").run(branchId, reason).lastInsertRowid);
}

export function enqueueAll(db, reason) {
  const rows = db.prepare("SELECT b.id FROM branches b JOIN repos r ON r.id = b.repo_id WHERE b.tracked = 1 AND r.tracked = 1").all();
  return rows.map((r) => enqueue(db, r.id, reason));
}

/** Runs the oldest queued job. Returns its result, or null when the queue is empty. */
export function runNextJob(db) {
  const job = db.prepare("SELECT * FROM sync_jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get();
  if (!job) return null;
  db.prepare("UPDATE sync_jobs SET state = 'running' WHERE id = ?").run(job.id);
  try {
    const result = syncBranch(db, job.branch_id, { force: job.reason === "resync" });
    db.prepare("UPDATE sync_jobs SET state = 'done', finished_at = ? WHERE id = ?").run(nowIso(), job.id);
    return { job: job.id, ...result };
  } catch (err) {
    db.prepare("UPDATE sync_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(err.message), nowIso(), job.id);
    db.prepare("UPDATE branches SET sync_error = ?, last_synced_at = ? WHERE id = ?").run(String(err.message), nowIso(), job.branch_id);
    return { job: job.id, error: err.message };
  }
}

/** Drains the queue. */
export function runAllJobs(db) {
  const results = [];
  for (let r = runNextJob(db); r; r = runNextJob(db)) results.push(r);
  db.prepare("DELETE FROM sync_jobs WHERE state IN ('done','failed') AND finished_at < ?")
    .run(new Date(Date.now() - 7 * 864e5).toISOString());
  return results;
}

/**
 * Reads and stores one branch. Skips the write when the content hash is unchanged
 * unless `force`.
 */
export function syncBranch(db, branchId, { force = false } = {}) {
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(branchId);
  if (!branch) throw new Error(`No branch ${branchId}`);
  const repo = db.prepare("SELECT r.*, c.platform FROM repos r JOIN connections c ON c.id = r.connection_id WHERE r.id = ?").get(branch.repo_id);
  if (repo.platform !== "local") throw new Error(`${repo.platform} repos are synced from milestone 3`);
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
