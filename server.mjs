// AI-DLC Tracker server.
//
//   PORT              default 3100
//   HOST              default 127.0.0.1 (local folders are readable only when bound to loopback, unless ALLOW_LOCAL_REPOS=1)
//   DATABASE_PATH     default ./data/tracker.db
//   LOCAL_REPOS       folders to track on start, separated by the platform path delimiter (":" on macOS and Linux)
//   POLL_SECONDS      how often local folders are re-read, default 30 (0 = off)
//   ALLOW_LOCAL_REPOS 1 or 0 to override the loopback rule

import { delimiter } from "node:path";
import { createApp } from "./src/app.mjs";

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || "127.0.0.1";
const loopback = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const allowLocal = process.env.ALLOW_LOCAL_REPOS ? process.env.ALLOW_LOCAL_REPOS === "1" : loopback;

const { server } = createApp({
  dbPath: process.env.DATABASE_PATH || "./data/tracker.db",
  allowLocal,
  pollSeconds: process.env.POLL_SECONDS !== undefined ? Number(process.env.POLL_SECONDS) : 30,
  localRepos: (process.env.LOCAL_REPOS ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean),
  log: (s) => console.log(s),
});

server.listen(PORT, HOST, () => {
  console.log(`AI-DLC Tracker listening on http://${HOST}:${PORT} (local folders ${allowLocal ? "allowed" : "off"})`);
});
