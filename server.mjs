// AI-DLC Tracker server.
//
//   PORT                 default 3100
//   HOST                 default 127.0.0.1 (local folders are readable only when bound to loopback, unless ALLOW_LOCAL_REPOS=1)
//   PUBLIC_URL           address people and GitHub use to reach the tracker; default http://127.0.0.1:PORT.
//                        GitHub webhooks are switched on only when this is not localhost.
//   DATABASE_PATH        default ./data/tracker.db (the encryption key is kept beside it in secret.key)
//   TRACKER_SECRET_KEY   32 bytes, base64: encryption key for stored GitHub credentials, instead of secret.key
//   SETUP_TOKEN          lets GitHub be set up from another computer (sent as X-Setup-Token)
//   LOCAL_REPOS          folders to track on start, separated by the platform path delimiter (":" on macOS and Linux)
//   POLL_SECONDS         how often local folders are re-read, default 30 (0 = off)
//   GITHUB_POLL_SECONDS  how often tracked GitHub branches are checked, default 30 (0 = off); unchanged checks are free
//   ALLOW_LOCAL_REPOS    1 or 0 to override the loopback rule

import { delimiter } from "node:path";
import { createApp } from "./src/app.mjs";

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || "127.0.0.1";
const loopback = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const allowLocal = process.env.ALLOW_LOCAL_REPOS ? process.env.ALLOW_LOCAL_REPOS === "1" : loopback;
const num = (v, d) => (v !== undefined && v !== "" ? Number(v) : d);

const { server } = createApp({
  dbPath: process.env.DATABASE_PATH || "./data/tracker.db",
  allowLocal,
  publicUrl: process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`,
  setupToken: process.env.SETUP_TOKEN || null,
  pollSeconds: num(process.env.POLL_SECONDS, 30),
  githubPollSeconds: num(process.env.GITHUB_POLL_SECONDS, 30),
  localRepos: (process.env.LOCAL_REPOS ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean),
  log: (s) => console.log(s),
});

server.listen(PORT, HOST, () => {
  console.log(`AI-DLC Tracker listening on http://${HOST}:${PORT} (local folders ${allowLocal ? "allowed" : "off"})`);
});
