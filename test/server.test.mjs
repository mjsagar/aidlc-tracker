import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { enqueueAll, runAllJobs } from "../src/sync.mjs";

const SAMPLE = new URL("../fixtures/repos/acme-shop", import.meta.url).pathname;
const TODO_Q = "aidlc/spaces/default/intents/261010-todo-bugfix/inception/requirements-analysis/requirements-analysis-questions.md";

let dir, repoPath, dbPath, app, base;

async function start(opts = {}) {
  app = createApp({ dbPath, pollSeconds: 0, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
};
const send = async (method, path, body, contentType = "application/json") => {
  const res = await fetch(base + path, { method, headers: contentType ? { "Content-Type": contentType } : {}, body });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-"));
  repoPath = join(dir, "acme-shop");
  cpSync(SAMPLE, repoPath, { recursive: true });
  dbPath = join(dir, "db", "tracker.db");
  await start({ localRepos: [repoPath] });
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("health reports the repo and its work", async () => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.status, "healthy");
  assert.equal(body.repos, 1);
  assert.equal(body.intents, 5);
  assert.equal(body.syncErrors, 0);
  assert.equal(body.aidlcCheckedAgainst, "2.11.3");
});

test("repos list the local folder with counts", async () => {
  const { body } = await get("/api/repos");
  assert.equal(body.length, 1);
  assert.deepEqual([body[0].name, body[0].platform, body[0].intents, body[0].openQuestions, body[0].waiting, body[0].aidlcVersion, body[0].syncError],
    ["acme-shop", "local", 5, 4, 2, "2.11.3", null]);
});

test("inbox: everything waiting, oldest first, with filters", async () => {
  const { body } = await get("/api/questions?open=true");
  assert.deepEqual(body.map((i) => [i.key, i.type]), [
    ["default/261020-checkout", "revising"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "summary"],
    ["default/261013-sku-totals", "awaiting-approval"],
    ["payments/261101-refunds", "question"],
  ]);
  // The refunds question file has no ARTIFACT_CREATED event, so its time is when the tracker first saw it.
  assert.ok(Date.now() - Date.parse(body.at(-1).since) < 60_000);
  assert.equal((await get("/api/questions?open=true&trade=Developer")).body.length, 1);
  assert.deepEqual((await get("/api/questions?open=true&type=approvals")).body.map((i) => i.type), ["revising", "awaiting-approval"]);
  assert.equal((await get("/api/questions?open=true&phase=inception")).body.length, 5);
  assert.equal((await get("/api/questions?open=false")).status, 400);
});

test("work list sorts and filters", async () => {
  const blocked = (await get("/api/intents")).body;
  assert.equal(blocked.length, 5);
  assert.deepEqual(blocked.slice(0, 2).map((i) => i.key), ["default/261020-checkout", "default/261010-todo-bugfix"]);
  assert.equal(blocked.at(-1).key, "default/261104-tempconv"); // nothing waiting
  const activity = (await get("/api/intents?sort=activity")).body;
  assert.equal(activity[0].key, "default/261104-tempconv");
  assert.equal((await get("/api/intents?phase=construction")).body.length, 1);
  assert.equal((await get("/api/intents?sort=nonsense")).status, 400);
});

test("one piece of work: stages, questions, events, approvals", async () => {
  const id = (await get("/api/intents")).body.find((i) => i.key === "default/261010-todo-bugfix").id;
  const { status, body } = await get(`/api/intents/${id}`);
  assert.equal(status, 200);
  assert.equal(body.description, "Fix the bug where completed todos reappear after a page reload.");
  assert.equal(body.stages.length, 33);
  assert.equal(body.questions.length, 5);
  const q2 = body.questions.find((q) => q.number === 2);
  assert.deepEqual([q2.open, q2.trade, q2.openSince, q2.options.length], [true, "Product owner", "2025-07-15T10:25:00Z", 4]);
  const q1 = body.questions.find((q) => q.number === 1);
  assert.equal(q1.answeredAt, "2025-07-15T10:29:00Z"); // from QUESTION_ANSWERED "Q1: ..."
  assert.equal(body.events.length, 9);
  assert.equal(body.approvals[0].gitName, "Priya Shah");
  assert.equal((await get("/api/intents/9999")).status, 404);
});

test("an answer written into the file closes the question on the next read", async () => {
  const file = join(repoPath, TODO_Q);
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.replace("## Q2.", "## Q2.").replace(/(Should completed todos stay visible[\s\S]*?)\[Answer\]:\n/, "$1[Answer]: A. Yes, in a collapsed \"Done\" section\n"));
  const repoId = (await get("/api/repos")).body[0].id;
  const { body } = await send("POST", `/api/repos/${repoId}/resync`, "{}");
  assert.equal(body.results[0].changed, true);

  const inbox = (await get("/api/questions?open=true")).body;
  assert.equal(inbox.length, 6);
  assert.ok(!inbox.some((i) => i.number === 2 && i.key === "default/261010-todo-bugfix"));
  const id = (await get("/api/intents")).body.find((i) => i.key === "default/261010-todo-bugfix").id;
  const q2 = (await get(`/api/intents/${id}`)).body.questions.find((q) => q.number === 2);
  assert.equal(q2.answer, "A. Yes, in a collapsed \"Done\" section");
  assert.ok(Date.now() - Date.parse(q2.answeredAt) < 60_000, "answered when the tracker saw it change");
});

test("new and removed work folders are picked up; unchanged reads are skipped", async () => {
  const repoId = (await get("/api/repos")).body[0].id;
  const unchanged = await send("POST", `/api/repos/${repoId}/resync`, "{}");
  assert.equal(unchanged.body.results[0].changed, true, "a manual resync always re-reads");
  enqueueAll(app.db, "poll");
  assert.deepEqual(runAllJobs(app.db).map((r) => r.changed), [false], "a poll with nothing changed skips the write");

  const extra = join(repoPath, "aidlc/spaces/default/intents/261112-new-thing");
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, "aidlc-state.md"), readFileSync(join(SAMPLE, "aidlc/spaces/default/intents/261013-sku-totals/aidlc-state.md"), "utf8"));
  await send("POST", `/api/repos/${repoId}/resync`, "{}");
  assert.equal((await get("/api/health")).body.intents, 6);
  rmSync(extra, { recursive: true });
  await send("POST", `/api/repos/${repoId}/resync`, "{}");
  assert.equal((await get("/api/health")).body.intents, 5);
});

test("adding folders: JSON only, real folders only", async () => {
  assert.equal((await send("POST", "/api/repos", JSON.stringify({ path: repoPath }), "text/plain")).status, 415);
  assert.equal((await send("POST", "/api/repos", JSON.stringify({ path: join(dir, "missing") }))).status, 400);
  assert.equal((await send("POST", "/api/repos", JSON.stringify({}))).status, 400);
  const again = await send("POST", "/api/repos", JSON.stringify({ path: repoPath }));
  assert.equal(again.status, 200, "adding the same folder twice returns the existing repo");
  assert.equal((await get("/api/repos")).body.length, 1);
});

test("static screens are served with security headers; no path escapes", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>AI-DLC Tracker<\/title>/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal((await get("/js/app.js")).status, 200);
  assert.equal((await get("/css/app.css")).status, 200);
  assert.notEqual((await get("/..%2fserver.mjs")).status, 200);
  assert.equal((await get("/nope.js")).status, 404);
  assert.equal((await get("/api/nope")).status, 404);
});

test("first-seen times survive a restart; removing a repo deletes its work", async () => {
  const before = (await get("/api/questions?open=true")).body.find((i) => i.key === "payments/261101-refunds").since;
  await app.close();
  await start();
  const afterRestart = (await get("/api/questions?open=true")).body.find((i) => i.key === "payments/261101-refunds").since;
  assert.equal(afterRestart, before);

  const repoId = (await get("/api/repos")).body[0].id;
  assert.equal((await send("DELETE", `/api/repos/${repoId}`, undefined, null)).status, 200);
  assert.equal((await get("/api/health")).body.intents, 0);
  assert.equal((await get("/api/questions?open=true")).body.length, 0);
});

test("local folders can be turned off", async () => {
  await app.close();
  await start({ allowLocal: false });
  assert.equal((await send("POST", "/api/repos", JSON.stringify({ path: repoPath }))).status, 403);
  assert.equal((await get("/api/health")).body.allowLocal, false);
});
