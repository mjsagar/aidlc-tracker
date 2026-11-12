// Runs the tracker against a fake GitHub and a fake GitLab (test/fake-github.mjs, test/fake-gitlab.mjs)
// so the connection screens can be tried without real accounts. Every GitHub and GitLab page is
// auto-approved and you sign in as "priya".
//
//   node --disable-warning=ExperimentalWarning scripts/demo.mjs     then open http://127.0.0.1:3101
//
// To connect GitLab on the Connections screen use Application ID demo-client, Secret demo-secret,
// access token glpat-demo, then track the project acme/shop.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { FakeGitHub, readDir } from "../test/fake-github.mjs";
import { FakeGitLab } from "../test/fake-gitlab.mjs";

const PORT = Number(process.env.PORT) || 3101;
const base = `http://127.0.0.1:${PORT}`;
const sample = readDir(new URL("../fixtures/repos/acme-shop", import.meta.url).pathname);

const gh = await new FakeGitHub().start();
gh.addRepo("acme/shop", sample, { id: 501 });
gh.install(77, "acme", ["acme/shop"]);
gh.addUser("priya", 9001, { 77: ["acme/shop"] });
gh.demoUser = "priya";
gh.setupUrl = `${base}/api/github/installed`;

const gl = await new FakeGitLab().start();
gl.addProject("acme/shop", sample, { id: 801 });
gl.addUser(1, "tracker-bot", ["acme/shop"]);
gl.addUser(2, "priya", ["acme/shop"]);
gl.addToken("glpat-demo", 1, { expiresAt: new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10) });
gl.oauthApps.set("demo-client", "demo-secret");
gl.demoUserId = 2;

const dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-demo-"));
const app = createApp({ dbPath: join(dir, "demo.db"), githubApiUrl: gh.url, githubWebUrl: gh.url, gitlabUrl: gl.url, publicUrl: base,
  githubPollSeconds: 10, gitlabPollSeconds: 10, pollSeconds: 0, log: console.log });
await app.ready;
app.server.listen(PORT, "127.0.0.1", () => console.log(`Demo tracker on ${base} (fake GitHub ${gh.url}, fake GitLab ${gl.url}, data in ${dir})`));
