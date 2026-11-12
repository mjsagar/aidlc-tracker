import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { enqueueAll } from "../src/sync.mjs";
import { currentSession, signIn, COOKIE } from "../src/auth.mjs";
import { FakeGitLab } from "./fake-gitlab.mjs";
import { readDir } from "./fake-github.mjs";

const SAMPLE = new URL("../fixtures/repos/acme-shop", import.meta.url).pathname;
const TODO_Q = "aidlc/spaces/default/intents/261010-todo-bugfix/inception/requirements-analysis/requirements-analysis-questions.md";
const PUBLIC = "https://tracker.example";

let gl, app, base, dir;
const cookies = {};

async function start() {
  app = createApp({ dbPath: join(dir, "tracker.db"), pollSeconds: 0, githubPollSeconds: 0, gitlabPollSeconds: 0,
    gitlabUrl: gl.url, publicUrl: PUBLIC });
  await app.ready;
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
const req = async (method, path, { body, as, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, redirect: "manual",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(as ? { Cookie: cookies[as] } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: data };
};
const get = (path, as) => req("GET", path, { as });

async function signInGitlab(username, userId) {
  const start = await get("/auth/gitlab/login");
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location"));
  assert.equal(to.pathname, "/oauth/authorize");
  assert.equal(to.searchParams.get("scope"), "read_api");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(to.searchParams.get("redirect_uri"), `${PUBLIC}/auth/gitlab/callback`);
  const code = gl.issueCode(userId, to.searchParams.get("code_challenge"), to.searchParams.get("redirect_uri"));
  const cb = await get(`/auth/gitlab/callback?code=${code}&state=${to.searchParams.get("state")}`);
  assert.equal(cb.headers.get("location"), "/#/", `sign-in for ${username} failed`);
  const cookie = cb.headers.get("set-cookie");
  assert.match(cookie, /Secure/, "a tracker on https sets Secure cookies");
  cookies[username] = cookie.split(";")[0];
}

const push = (headers, body) => req("POST", "/api/webhooks/gitlab", { body, headers: { "X-Gitlab-Event": "Push Hook", "X-Gitlab-Event-UUID": randomUUID(), ...headers } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-gl-"));
  gl = await new FakeGitLab().start();
  gl.addProject("acme/shop", readDir(SAMPLE), { id: 801 });
  gl.addProject("acme/secret", new Map([["README.md", "private"]]), { id: 802 });
  gl.addUser(1, "tracker-bot", ["acme/shop", "acme/secret"]);
  gl.addUser(2, "priya", ["acme/shop", "acme/secret"]);
  gl.addUser(3, "lee", ["acme/secret"]);
  gl.addToken("glpat-good", 1, { expiresAt: new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10) });
  gl.addToken("glpat-soon", 1, { expiresAt: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
  gl.addToken("glpat-noscope", 1, { scopes: ["read_user"] });
  gl.oauthApps.set("gl-client", "gl-secret");
  gl.perPage = 7; // forces tree pagination
  await start();
});
after(async () => {
  await app.close();
  await gl.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("an https tracker sends HSTS", async () => {
  assert.equal((await get("/")).headers.get("strict-transport-security"), "max-age=31536000");
});

test("setup refuses bad tokens and stores the good one encrypted", async () => {
  const me0 = (await get("/api/me")).body;
  assert.deepEqual([me0.gitlab.configured, me0.gitlab.canSetUp, me0.gitlab.redirectUri], [false, true, `${PUBLIC}/auth/gitlab/callback`]);
  const setup = (token) => req("POST", "/api/gitlab/setup", { body: { clientId: "gl-client", clientSecret: "gl-secret", token } });
  assert.equal((await req("POST", "/api/gitlab/setup", { body: { clientId: "gl-client" } })).status, 400);
  assert.match((await setup("glpat-wrong")).body.error, /did not accept/);
  assert.match((await setup("glpat-noscope")).body.error, /read_api/);
  const ok = await setup("glpat-good");
  assert.equal(ok.status, 201);
  assert.equal(ok.body.account, "tracker-bot");
  assert.equal((await setup("glpat-good")).status, 409);
  const conn = app.db.prepare("SELECT * FROM connections WHERE platform = 'gitlab'").get();
  assert.ok(!conn.credentials_enc.includes("glpat"));
  assert.ok(!app.db.prepare("SELECT client_secret_enc FROM gitlab_app").get().client_secret_enc.includes("gl-secret"));
  assert.equal((await get("/api/repos")).status, 401, "sign-in is required once GitLab is set up");
});

test("sign-in with GitLab uses PKCE; a forged state or verifier fails", async () => {
  const start = await get("/auth/gitlab/login");
  const to = new URL(start.headers.get("location"));
  const wrongChallenge = gl.issueCode(2, "not-the-challenge", to.searchParams.get("redirect_uri"));
  const bad = await get(`/auth/gitlab/callback?code=${wrongChallenge}&state=${to.searchParams.get("state")}`);
  assert.equal(bad.headers.get("location"), "/#/signin?error=failed");
  assert.equal((await get(`/auth/gitlab/callback?code=x&state=forged`)).headers.get("location"), "/#/signin?error=state");
  await signInGitlab("priya", 2);
  await signInGitlab("lee", 3);
  const me = (await get("/api/me", "priya")).body;
  assert.deepEqual([me.user.login, me.user.gitlab, me.user.github], ["priya", "priya", null]);
  assert.equal(me.gitlab.webhook.url, `${PUBLIC}/api/webhooks/gitlab`);
});

test("tracking a project: only someone who can read it may add it", async () => {
  const list = (await get("/api/gitlab/projects", "priya")).body;
  assert.deepEqual(list.map((x) => x.path).sort(), ["acme/secret", "acme/shop"]);
  assert.equal((await req("POST", "/api/gitlab/projects", { as: "lee", body: { path: "acme/shop" } })).status, 404);
  assert.equal((await req("POST", "/api/gitlab/projects", { as: "priya", body: { path: "acme/nothing" } })).status, 404);
  const added = await req("POST", "/api/gitlab/projects", { as: "priya", body: { path: `${gl.url}/acme/shop.git` } });
  assert.equal(added.status, 201);
  assert.deepEqual([added.body.name, added.body.platform, added.body.intents, added.body.aidlcVersion], ["acme/shop", "gitlab", 5, "2.11.3"]);
  assert.equal(added.body.branches[0].syncError, null);
});

test("each person sees only projects their GitLab account can read", async () => {
  const inbox = (await get("/api/questions?open=true", "priya")).body;
  assert.equal(inbox.length, 7);
  assert.equal(inbox.find((i) => i.number === 2).url, `${gl.url}/acme/shop/-/blob/main/${TODO_Q}#L26`);
  assert.equal((await get("/api/questions?open=true", "lee")).body.length, 0);
  assert.deepEqual((await get("/api/repos", "lee")).body, []);
});

test("polling: unchanged costs one request; a committed answer is picked up", async () => {
  const b0 = gl.requests.length;
  enqueueAll(app.db, "poll", { platform: "gitlab" });
  assert.deepEqual((await app.kick()).map((r) => r.changed), [false]);
  assert.deepEqual(gl.requests.slice(b0).map((r) => r.split("?")[0]), ["GET /api/v4/projects/801/repository/branches/main"]);

  const text = gl.getFile("acme/shop", "main", TODO_Q);
  gl.setFile("acme/shop", "main", TODO_Q, text.replace(/(Should completed todos stay visible[\s\S]*?)\[Answer\]:\n/, "$1[Answer]: A. Yes, in a collapsed \"Done\" section\n"));
  const blobs0 = gl.count(/repository\/blobs/);
  enqueueAll(app.db, "poll", { platform: "gitlab" });
  const [r] = await app.kick();
  assert.equal(r.changed, true);
  assert.equal(gl.count(/repository\/blobs/) - blobs0, 1, "only the edited file is downloaded");
  assert.equal((await get("/api/questions?open=true", "priya")).body.length, 6);
});

test("webhooks: the secret token is checked; a push is queued and read", async () => {
  const secret = (await get("/api/me", "priya")).body.gitlab.webhook.secret;
  const payload = { ref: "refs/heads/main", after: "c".repeat(40), project: { id: 801 } };
  assert.equal((await push({ "X-Gitlab-Token": "wrong" }, payload)).status, 401);
  assert.equal((await push({ "X-Gitlab-Token": secret }, { ...payload, project: { id: 999 } })).status, 401, "untracked projects look the same as a wrong secret");
  const text = gl.getFile("acme/shop", "main", TODO_Q);
  gl.setFile("acme/shop", "main", TODO_Q, text.replace(/(Where should todos be stored[\s\S]*?)\[Answer\]: ______/, "$1[Answer]: A"));
  const uuid = randomUUID();
  const res = await push({ "X-Gitlab-Token": secret, "X-Gitlab-Event-UUID": uuid }, payload);
  assert.equal(res.status, 202);
  await app.idle();
  assert.equal((await get("/api/questions?open=true", "priya")).body.length, 5);
  assert.deepEqual((await push({ "X-Gitlab-Token": secret, "X-Gitlab-Event-UUID": uuid }, payload)).body, { duplicate: true });
  assert.deepEqual((await push({ "X-Gitlab-Token": secret }, { ...payload, ref: "refs/heads/other" })).body, { ignored: "branch not tracked" });
});

test("rate limits defer GitLab jobs", async () => {
  gl.failNext = { match: /GET \/api\/v4\/projects\/801\/repository\/branches/, status: 429, headers: { "Retry-After": "90" }, body: { message: "Too Many Requests" } };
  enqueueAll(app.db, "poll", { platform: "gitlab" });
  const results = await app.kick();
  assert.ok(results.some((r) => r.deferred));
  const job = app.db.prepare("SELECT * FROM sync_jobs WHERE state = 'queued'").get();
  assert.ok(Date.parse(job.run_after) > Date.now() + 80_000);
  app.db.prepare("UPDATE sync_jobs SET run_after = NULL WHERE id = ?").run(job.id);
  await app.kick();
});

test("replacing the token: warns when it expires soon; refuses a bad one", async () => {
  assert.equal((await req("PUT", "/api/gitlab/token", { as: "priya", body: { token: "glpat-noscope" } })).status, 400);
  const ok = await req("PUT", "/api/gitlab/token", { as: "priya", body: { token: "glpat-soon" } });
  assert.equal(ok.status, 200);
  const expires = Date.parse((await get("/api/me", "priya")).body.gitlab.tokenExpiresAt);
  assert.ok(expires - Date.now() < 14 * 864e5);
});

test("a lost project is flagged, not deleted", async () => {
  gl.users.get(1).projects.delete("acme/shop");
  await req("PUT", "/api/gitlab/token", { as: "priya", body: { token: "glpat-good" } }); // re-reads project metadata
  const repo = (await get("/api/repos", "priya")).body.find((r) => r.name === "acme/shop");
  assert.match(repo.branches[0].syncError, /can no longer read/);
  gl.users.get(1).projects.add("acme/shop");
  await req("PUT", "/api/gitlab/token", { as: "priya", body: { token: "glpat-good" } });
  assert.equal((await get("/api/repos", "priya")).body.find((r) => r.name === "acme/shop").branches[0].syncError, null);
});

test("an expired GitLab sign-in is refreshed on the hourly check", async () => {
  const raw = decodeURIComponent(cookies.priya.split("=")[1]);
  app.db.prepare("UPDATE sessions SET gitlab_checked_at = '2000-01-01T00:00:00Z', gitlab_expires_at = '2000-01-01T00:00:00Z'").run();
  const refreshes = gl.count(/POST \/oauth\/token/);
  const me = (await get("/api/me", "priya")).body;
  assert.equal(me.signedIn, true);
  assert.equal(gl.count(/POST \/oauth\/token/) - refreshes, 1, "only the session that made a request is refreshed");
  const again = (await get("/api/me", "priya")).body;
  assert.equal(again.signedIn, true, "the rotated refresh token was saved");
  assert.equal(gl.count(/POST \/oauth\/token/) - refreshes, 1, "no second refresh within the hour");
  assert.ok(raw.length > 20);
  assert.equal((await get("/api/questions?open=true", "priya")).body.length, 5);
});

test("one session can hold a GitHub and a GitLab sign-in", async () => {
  const key = Buffer.from(readFileSync(join(dir, "secret.key"), "utf8").trim(), "base64");
  const raw = decodeURIComponent(cookies.priya.split("=")[1]);
  signIn(app.db, key, { provider: "github", user: { id: 1, login: "priya-gh" }, login: "priya-gh", token: "ghu_x", repoIds: ["5"] }, raw);
  const s = await currentSession({ db: app.db, key, github: () => null, gitlab: () => null }, { headers: { cookie: `${COOKIE}=${encodeURIComponent(raw)}` } });
  assert.equal(s.github.login, "priya-gh");
  assert.equal(s.gitlab.login, "priya");
});

test("removing a GitLab project stops tracking it", async () => {
  const repo = (await get("/api/repos", "priya")).body.find((r) => r.name === "acme/shop");
  assert.equal((await req("DELETE", `/api/repos/${repo.id}`, { as: "priya" })).status, 200);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM intents").get().n, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n, 0);
});
