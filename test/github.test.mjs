import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { enqueueAll } from "../src/sync.mjs";
import { appJwt } from "../src/github/client.mjs";
import { verifyGithubSignature, encrypt, decrypt } from "../src/secrets.mjs";
import { FakeGitHub, readDir } from "./fake-github.mjs";

const SAMPLE = new URL("../fixtures/repos/acme-shop", import.meta.url).pathname;
const TODO_Q = "aidlc/spaces/default/intents/261010-todo-bugfix/inception/requirements-analysis/requirements-analysis-questions.md";
const HOOK_SECRET = "hook-secret";

let gh, app, base, dir;
const cookies = {};

async function start() {
  app = createApp({ dbPath: join(dir, "tracker.db"), pollSeconds: 0, githubPollSeconds: 0, githubApiUrl: gh.url, githubWebUrl: gh.url,
    publicUrl: "http://127.0.0.1:3100" });
  await app.ready;
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
const req = async (method, path, { body, as, headers = {}, contentType = "application/json" } = {}) => {
  const res = await fetch(base + path, { method, redirect: "manual",
    headers: { ...(body !== undefined && contentType ? { "Content-Type": contentType } : {}), ...(as ? { Cookie: cookies[as] } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: data };
};
const get = (path, as) => req("GET", path, { as });

function webhook(event, payload, { delivery = randomUUID(), secret = HOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  return req("POST", "/api/webhooks/github", { body: raw, headers: {
    "X-GitHub-Event": event, "X-GitHub-Delivery": delivery,
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  } });
}

async function signIn(login) {
  const start = await get("/auth/github/login");
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location"));
  assert.equal(to.pathname, "/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "Iv1.client");
  const cb = await get(`/auth/github/callback?code=${gh.authorize(login)}&state=${to.searchParams.get("state")}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/#/");
  const cookie = cb.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  cookies[login] = cookie.split(";")[0];
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-gh-"));
  gh = await new FakeGitHub().start();
  const files = readDir(SAMPLE);
  gh.addRepo("acme/shop", files, { id: 501 });
  gh.addRepo("acme/other", new Map([["README.md", "no AI-DLC here"]]), { id: 502 });
  gh.install(77, "acme", ["acme/shop", "acme/other"]);
  gh.addUser("priya", 9001, { 77: ["acme/shop", "acme/other"] });
  gh.addUser("sam", 9002, { 77: ["acme/other"] });
  gh.perPage = 1; // forces pagination on every list
  await start();
});
after(async () => {
  await app.close();
  await gh.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("helpers: webhook signatures and app JWTs", () => {
  const raw = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac("sha256", "s").update(raw).digest("hex")}`;
  assert.equal(verifyGithubSignature("s", raw, good), true);
  assert.equal(verifyGithubSignature("s", Buffer.from('{"a":2}'), good), false);
  assert.equal(verifyGithubSignature("s", raw, "sha1=abc"), false);
  assert.equal(verifyGithubSignature(null, raw, good), false);
  assert.equal(gh.verifyJwt(appJwt(gh.appId, gh.pem)), true);
  const key = Buffer.alloc(32, 7);
  const sealed = encrypt(key, "secret value");
  assert.ok(!sealed.includes("secret"));
  assert.equal(decrypt(key, sealed), "secret value");
});

test("before setup: open access, and setup is offered on this computer", async () => {
  const me = (await get("/api/me")).body;
  assert.deepEqual([me.authRequired, me.signedIn, me.github.configured, me.github.canSetUp, me.github.webhooks], [false, false, false, true, false]);
  assert.equal((await get("/api/questions?open=true")).status, 200);
});

test("setup: manifest, a stale state is refused, then conversion stores the app encrypted", async () => {
  const { status, body } = await req("POST", "/api/github/manifest", { body: { org: "acme" } });
  assert.equal(status, 200);
  const action = new URL(body.action);
  assert.equal(action.pathname, "/organizations/acme/settings/apps/new");
  assert.deepEqual(body.manifest.default_permissions, { contents: "read", metadata: "read" });
  assert.equal(body.manifest.public, false);
  assert.equal(body.manifest.hook_attributes, undefined, "no webhook while the tracker is on localhost");
  assert.equal(body.manifest.redirect_url, "http://127.0.0.1:3100/api/github/manifest/callback");
  assert.equal((await req("POST", "/api/github/manifest", { body: { org: "bad org!" } })).status, 400);

  const wrong = await get(`/api/github/manifest/callback?code=good-code&state=nope`);
  assert.equal(wrong.headers.get("location"), "/#/connections?error=setup");

  const done = await get(`/api/github/manifest/callback?code=good-code&state=${action.searchParams.get("state")}`);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("location"), `${gh.url}/apps/aidlc-tracker-test/installations/new`);
  const row = app.db.prepare("SELECT * FROM github_app").get();
  assert.equal(row.slug, "aidlc-tracker-test");
  assert.ok(!row.pem_enc.includes("PRIVATE KEY") && !row.client_secret_enc.includes("client-secret") && !row.webhook_secret_enc.includes(HOOK_SECRET));
  assert.equal((await req("POST", "/api/github/manifest", { body: {} })).status, 409);
});

test("after setup everything needs sign-in, except health and webhooks", async () => {
  assert.equal((await get("/api/questions?open=true")).status, 401);
  assert.equal((await get("/api/repos")).status, 401);
  assert.equal((await get("/api/health")).status, 200);
  assert.equal((await get("/api/me")).body.authRequired, true);
});

test("installing the app backfills its repos and reads the default branch", async () => {
  const res = await get("/api/github/installed?installation_id=77&setup_action=install");
  assert.equal(res.headers.get("location"), "/auth/github/login");
  await app.idle();
  const repos = app.db.prepare("SELECT full_name, default_branch FROM repos ORDER BY full_name").all();
  assert.deepEqual(repos.map((r) => r.full_name), ["acme/other", "acme/shop"]);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM intents").get().n, 5);
  assert.equal((await get("/api/health")).body.syncErrors, 0);
});

test("sign-in: Priya sees both repos; Sam only sees the one he can read on GitHub", async () => {
  await signIn("priya");
  await signIn("sam");
  const me = (await get("/api/me", "priya")).body;
  assert.equal(me.user.login, "priya");
  assert.deepEqual((await get("/api/repos", "priya")).body.map((r) => r.name), ["acme/other", "acme/shop"]);
  assert.deepEqual((await get("/api/repos", "sam")).body.map((r) => r.name), ["acme/other"]);

  const inbox = (await get("/api/questions?open=true", "priya")).body;
  assert.equal(inbox.length, 7);
  const q2 = inbox.find((i) => i.number === 2);
  assert.equal(q2.url, `${gh.url}/acme/shop/blob/main/${TODO_Q}#L26`);
  assert.equal((await get("/api/questions?open=true", "sam")).body.length, 0);

  const id = (await get("/api/intents", "priya")).body[0].id;
  assert.equal((await get(`/api/intents/${id}`, "sam")).status, 404, "a repo Sam cannot read is not found, not forbidden");
  const shopId = app.db.prepare("SELECT id FROM repos WHERE full_name = 'acme/shop'").get().id;
  assert.equal((await req("POST", `/api/repos/${shopId}/resync`, { as: "sam", body: {} })).status, 404);
  const tok = app.db.prepare("SELECT github_token_enc FROM sessions LIMIT 1").get().github_token_enc;
  assert.ok(!tok.startsWith("ghu_"), "user tokens are stored encrypted");
});

test("a repo added to the installation after sign-in shows up at once, not after the hourly check", async () => {
  gh.addRepo("acme/late", readDir(SAMPLE), { id: 503 });
  gh.installations.get(77).repos.add("acme/late");
  gh.users.get("priya").access[77].push("acme/late");
  const res = await webhook("installation_repositories", { action: "added", installation: { id: 77, account: { login: "acme" } } });
  assert.equal(res.status, 202);
  await app.idle();
  assert.ok((await get("/api/repos", "priya")).body.some((r) => r.name === "acme/late"));
  assert.ok(!(await get("/api/repos", "sam")).body.some((r) => r.name === "acme/late"), "Sam still cannot read it");
  // Put things back for the tests that follow.
  gh.installations.get(77).repos.delete("acme/late");
  gh.users.get("priya").access[77] = gh.users.get("priya").access[77].filter((n) => n !== "acme/late");
  await webhook("installation_repositories", { action: "removed", installation: { id: 77, account: { login: "acme" } } });
  await app.idle();
});

test("a bad sign-in state is refused", async () => {
  const cb = await get(`/auth/github/callback?code=${gh.authorize("priya")}&state=forged`);
  assert.equal(cb.headers.get("location"), "/#/signin?error=state");
  assert.equal(cb.headers.get("set-cookie"), null);
});

test("webhooks: bad signatures refused, repeats ignored", async () => {
  const push = { ref: "refs/heads/main", after: "a".repeat(40), installation: { id: 77 }, repository: { id: 501 } };
  assert.equal((await webhook("push", push, { secret: "wrong" })).status, 401);
  const delivery = randomUUID();
  assert.equal((await webhook("ping", {}, { delivery })).status, 200);
  assert.deepEqual((await webhook("ping", {}, { delivery })).body, { duplicate: true });
  assert.deepEqual((await webhook("push", { ...push, ref: "refs/heads/other" })).body, { ignored: "branch not tracked" });
  assert.deepEqual((await webhook("push", { ...push, ref: "refs/tags/v1" })).body, { ignored: "not a branch update" });
});

test("a push that answers a question clears it from the inbox, fetching only the changed file", async () => {
  const before = gh.getFile("acme/shop", "main", TODO_Q);
  gh.setFile("acme/shop", "main", TODO_Q, before.replace(/(Should completed todos stay visible[\s\S]*?)\[Answer\]:\n/, "$1[Answer]: B. Yes, at the bottom of the list\n"));
  const blobsBefore = gh.count(/git\/blobs/);
  const t0 = Date.now();
  const res = await webhook("push", { ref: "refs/heads/main", after: "b".repeat(40), installation: { id: 77 }, repository: { id: 501 } });
  assert.equal(res.status, 202);
  await app.idle();
  assert.ok(Date.now() - t0 < 60_000);
  assert.equal(gh.count(/git\/blobs/) - blobsBefore, 1, "only the edited file is downloaded");
  const inbox = (await get("/api/questions?open=true", "priya")).body;
  assert.equal(inbox.length, 6);
  assert.ok(!inbox.some((i) => i.number === 2 && i.key === "default/261010-todo-bugfix"));
});

test("polling: an unchanged branch costs one free conditional request; a change is picked up", async () => {
  const before = gh.requests.length;
  enqueueAll(app.db, "poll", { platform: "github" });
  const results = await app.kick();
  assert.deepEqual(results.map((r) => r.changed), [false, false]);
  const made = gh.requests.slice(before);
  assert.ok(made.every((r) => /\/branches\/main \[conditional\]$/.test(r)), made.join("\n"));

  // A push that does not touch aidlc/ is two requests and no write.
  gh.setFile("acme/shop", "main", "src/app.js", "console.log(1)\n");
  const b2 = gh.requests.length;
  enqueueAll(app.db, "poll", { platform: "github" });
  assert.deepEqual((await app.kick()).map((r) => r.changed), [false, false]);
  assert.equal(gh.requests.slice(b2).filter((r) => /git\/trees/.test(r)).length, 1);

  // An answer committed without a webhook arrives on the next poll.
  const text = gh.getFile("acme/shop", "main", TODO_Q);
  gh.setFile("acme/shop", "main", TODO_Q, text.replace(/(Do existing users need[\s\S]*?)\[Answer\]:[ \t]*\n/, "$1[Answer]: B. No, start fresh\n"));
  enqueueAll(app.db, "poll", { platform: "github" });
  await app.kick();
  assert.equal((await get("/api/questions?open=true", "priya")).body.length, 5);
  const stats = (await get("/api/health")).body.last7Days.github;
  assert.equal(stats.byWebhook, 1, "the earlier push arrived by webhook");
  assert.equal(stats.byPolling, 1, "this change was found by polling, as a missed webhook would be");
});

test("a webhook landing on a queued poll still counts as delivered by webhook", async () => {
  const shopBranch = app.db.prepare("SELECT b.id FROM branches b JOIN repos r ON r.id = b.repo_id WHERE r.full_name = 'acme/shop'").get().id;
  enqueueAll(app.db, "poll", { platform: "github" });
  const text = gh.getFile("acme/shop", "main", TODO_Q);
  gh.setFile("acme/shop", "main", TODO_Q, text.replace("# Requirements Analysis Questions", "# Requirements Analysis Questions (edited)"));
  await webhook("push", { ref: "refs/heads/main", after: "d".repeat(40), installation: { id: 77 }, repository: { id: 501 } });
  await app.idle();
  const job = app.db.prepare("SELECT reason, changed FROM sync_jobs WHERE branch_id = ? ORDER BY id DESC LIMIT 1").get(shopBranch);
  assert.deepEqual([job.reason, job.changed], ["push", 1]);
  assert.equal((await get("/api/health")).body.last7Days.github.byWebhook, 2);
});

test("rate limits defer the job instead of failing the branch", async () => {
  gh.failNext = { match: /GET \/repos\/acme\/shop\/branches/, status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }, body: { message: "API rate limit exceeded" } };
  enqueueAll(app.db, "poll", { platform: "github" });
  const results = await app.kick();
  assert.ok(results.some((r) => r.deferred));
  const job = app.db.prepare("SELECT * FROM sync_jobs WHERE state = 'queued'").get();
  assert.ok(job && Date.parse(job.run_after) > Date.now() + 60_000);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM branches WHERE sync_error IS NOT NULL").get().n, 0);
  app.db.prepare("UPDATE sync_jobs SET run_after = NULL WHERE id = ?").run(job.id); // let it run now
  await app.kick();
});

test("tracking another branch, and refusing bad names", async () => {
  const shopId = app.db.prepare("SELECT id FROM repos WHERE full_name = 'acme/shop'").get().id;
  gh.commit("acme/shop", "feature/refunds", new Map(gh.repos.get("acme/shop").branches.get("main").files));
  assert.equal((await req("POST", `/api/repos/${shopId}/branches`, { as: "priya", body: { name: "bad name" } })).status, 400);
  const added = await req("POST", `/api/repos/${shopId}/branches`, { as: "priya", body: { name: "feature/refunds" } });
  assert.equal(added.status, 201);
  const branches = added.body.repo.branches;
  assert.deepEqual(branches.map((b) => [b.name, b.intents, b.syncError]), [["feature/refunds", 5, null], ["main", 5, null]]);
  const inbox = (await get("/api/questions?open=true", "priya")).body;
  assert.ok(inbox.some((i) => i.branch === "feature/refunds" && i.url.includes("/blob/feature/refunds/")));
  const missing = await req("POST", `/api/repos/${shopId}/branches`, { as: "priya", body: { name: "nope" } });
  assert.match(missing.body.repo.branches.find((b) => b.name === "nope").syncError, /404/);
  for (const b of missing.body.repo.branches.filter((x) => x.name !== "main")) {
    assert.equal((await req("DELETE", `/api/repos/${shopId}/branches/${b.id}`, { as: "priya" })).status, 200);
  }
  const mainId = app.db.prepare("SELECT id FROM branches WHERE repo_id = ?").get(shopId).id;
  assert.equal((await req("DELETE", `/api/repos/${shopId}/branches/${mainId}`, { as: "priya" })).status, 400, "the last branch stays");
});

test("removing a repo from the installation removes it from the tracker", async () => {
  gh.installations.get(77).repos.delete("acme/shop");
  const res = await webhook("installation_repositories", { action: "removed", installation: { id: 77, account: { login: "acme" } } });
  assert.equal(res.status, 202);
  await app.idle();
  assert.deepEqual(app.db.prepare("SELECT full_name FROM repos").all().map((r) => r.full_name), ["acme/other"]);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM intents").get().n, 0);
  const orphans = app.db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE sha NOT IN (SELECT sha FROM files)").get().n;
  assert.equal(orphans, 0);
});

test("credentials and sessions survive a restart; sign-out ends the session", async () => {
  await app.close();
  await start();
  assert.equal((await get("/api/me", "priya")).body.signedIn, true);
  const out = await req("POST", "/api/auth/signout", { as: "priya", body: {} });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await get("/api/repos", "priya")).status, 401);
});

test("uninstalling the app removes the connection", async () => {
  const res = await webhook("installation", { action: "deleted", installation: { id: 77, account: { login: "acme" } } });
  assert.deepEqual(res.body, { removed: true });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM repos").get().n, 0);
});
