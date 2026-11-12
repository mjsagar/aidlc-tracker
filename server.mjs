// AI-DLC Tracker server.
//
//   PORT                 default 3100
//   HOST                 default 127.0.0.1; set 0.0.0.0 in a container
//                        (local folders are readable only when bound to loopback, unless ALLOW_LOCAL_REPOS=1)
//   PUBLIC_URL           address people and GitHub use to reach the tracker; default http://127.0.0.1:PORT.
//                        When it is not localhost, GitHub webhooks are on and cookies are Secure on https.
//   DATABASE_PATH        default ./data/tracker.db (the encryption key is kept beside it in secret.key)
//   TRACKER_SECRET_KEY   32 bytes, base64: encryption key for stored credentials, instead of secret.key
//   SETUP_TOKEN          lets GitHub and GitLab be set up from another computer (entered on the Connections screen)
//   LOCAL_REPOS          folders to track on start, separated by the platform path delimiter (":" on macOS and Linux)
//   POLL_SECONDS         how often local folders are re-read, default 30 (0 = off)
//   GITHUB_POLL_SECONDS  how often tracked GitHub branches are checked; default 30, or 300 when webhooks are on
//                        (then polling is only a backstop for missed webhooks). Unchanged checks are free.
//   GITLAB_POLL_SECONDS  how often tracked GitLab branches are checked, default 30 (0 = off)
//   ALLOW_LOCAL_REPOS    1 or 0 to override the loopback rule

import { delimiter } from "node:path";
import { createApp } from "./src/app.mjs";

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const loopback = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const webhooksOn = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(PUBLIC_URL);
const allowLocal = process.env.ALLOW_LOCAL_REPOS ? process.env.ALLOW_LOCAL_REPOS === "1" : loopback;
const num = (v, d) => (v !== undefined && v !== "" ? Number(v) : d);

const app = createApp({
  dbPath: process.env.DATABASE_PATH || "./data/tracker.db",
  allowLocal,
  publicUrl: PUBLIC_URL,
  setupToken: process.env.SETUP_TOKEN || null,
  localSetup: loopback,
  pollSeconds: num(process.env.POLL_SECONDS, 30),
  githubPollSeconds: num(process.env.GITHUB_POLL_SECONDS, webhooksOn ? 300 : 30),
  gitlabPollSeconds: num(process.env.GITLAB_POLL_SECONDS, 30),
  localRepos: (process.env.LOCAL_REPOS ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean),
  log: (s) => console.log(s),
});

app.server.listen(PORT, HOST, () => {
  console.log(`AI-DLC Tracker listening on http://${HOST}:${PORT}, public at ${PUBLIC_URL} ` +
    `(webhooks ${webhooksOn ? "on" : "off"}, local folders ${allowLocal ? "allowed" : "off"}, set-up token ${process.env.SETUP_TOKEN ? "set" : "not set"})`);
});

// Redeploys send SIGTERM: stop taking requests, let running sync jobs finish, close the database.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received; finishing work and shutting down`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    try { await app.close(); } catch (err) { console.error(err); }
    process.exit(0);
  });
}
