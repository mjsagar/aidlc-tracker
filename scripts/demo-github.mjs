// Runs the tracker against a fake GitHub (test/fake-github.mjs) so the GitHub screens can be
// tried without a real GitHub App. Every GitHub page is auto-approved; you sign in as "priya".
//
//   node scripts/demo-github.mjs          then open http://127.0.0.1:3101
//   GitHub branches are checked every 10 seconds.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { FakeGitHub, readDir } from "../test/fake-github.mjs";

const PORT = Number(process.env.PORT) || 3101;
const base = `http://127.0.0.1:${PORT}`;
const gh = await new FakeGitHub().start();
gh.addRepo("acme/shop", readDir(new URL("../fixtures/repos/acme-shop", import.meta.url).pathname), { id: 501 });
gh.install(77, "acme", ["acme/shop"]);
gh.addUser("priya", 9001, { 77: ["acme/shop"] });
gh.demoUser = "priya";
gh.setupUrl = `${base}/api/github/installed`;

const dir = mkdtempSync(join(tmpdir(), "aidlc-tracker-demo-"));
const app = createApp({ dbPath: join(dir, "demo.db"), githubApiUrl: gh.url, githubWebUrl: gh.url, publicUrl: base, githubPollSeconds: 10, pollSeconds: 0, log: console.log });
await app.ready;
app.server.listen(PORT, "127.0.0.1", () => console.log(`Demo tracker on ${base} (fake GitHub ${gh.url}, data in ${dir})`));
