// Behaviour that matters once the tracker runs behind a proxy on a public address.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createApp } from "../src/app.mjs";

let app, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-deploy-"));
  app = createApp({ dbPath: join(dir, "t.db"), pollSeconds: 0, githubPollSeconds: 0, gitlabPollSeconds: 0,
    publicUrl: "https://tracker.example", setupToken: "s3t-up-token", localSetup: false, allowLocal: false });
  await app.ready;
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("behind a proxy, set-up needs the set-up token even from loopback", async () => {
  const me = await (await fetch(`${base}/api/me`)).json();
  assert.deepEqual([me.github.canSetUp, me.gitlab.canSetUp, me.github.webhooks, me.allowLocal], [false, false, true, false]);
  assert.equal((await post("/api/github/manifest", {})).status, 403);
  assert.equal((await post("/api/github/manifest", {}, { "X-Setup-Token": "wrong" })).status, 403);
  const ok = await post("/api/github/manifest", {}, { "X-Setup-Token": "s3t-up-token" });
  assert.equal(ok.status, 200);
  const { manifest } = await ok.json();
  assert.deepEqual(manifest.hook_attributes, { url: "https://tracker.example/api/webhooks/github", active: true });
  assert.deepEqual(manifest.default_events, ["push"]);
  assert.equal(manifest.redirect_url, "https://tracker.example/api/github/manifest/callback");
  const meWithToken = await (await fetch(`${base}/api/me`, { headers: { "X-Setup-Token": "s3t-up-token" } })).json();
  assert.equal(meWithToken.github.canSetUp, true);
});

test("local folders are refused on a public tracker", async () => {
  assert.equal((await post("/api/repos", { path: "/etc" })).status, 403);
});

test("the server shuts down cleanly on SIGTERM", async () => {
  const port = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "sig.db"), POLL_SECONDS: "0", GITHUB_POLL_SECONDS: "0", GITLAB_POLL_SECONDS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no start: ${out}`)), 10_000);
    child.stdout.on("data", () => { if (out.includes("listening")) { clearTimeout(t); resolve(); } });
  });
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.match(out, /SIGTERM received/);
});
