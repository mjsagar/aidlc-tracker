// Smoke test against a running tracker, local or deployed. Changes nothing.
//
//   BASE_URL=https://your-tracker.up.railway.app node scripts/smoke.mjs
//
// Exits 1 if any check fails.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const https = BASE.startsWith("https://");
let failed = 0;

async function check(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name}: ${err.message}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const get = (path, opts) => fetch(BASE + path, { redirect: "manual", ...opts });

const health = await (await get("/api/health")).json().catch(() => null);

await check("health reports healthy", async () => {
  expect(health?.status === "healthy", `got ${JSON.stringify(health)}`);
});
await check("no branch has a sync error", async () => {
  expect(health.syncErrors === 0, `${health.syncErrors} branch(es) failing; see Connections`);
});
await check("sync queue is not backed up", async () => {
  expect(health.queued < 50, `${health.queued} jobs queued`);
});
await check("the page loads with security headers", async () => {
  const res = await get("/");
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.text()).includes("<title>AI-DLC Tracker</title>"), "not the tracker page");
  expect(/default-src 'self'/.test(res.headers.get("content-security-policy") ?? ""), "no CSP");
  expect(res.headers.get("x-frame-options") === "DENY", "no X-Frame-Options");
  if (https) expect(res.headers.get("strict-transport-security"), "no HSTS on https");
});
await check("scripts and styles are served", async () => {
  for (const p of ["/js/app.js", "/js/dom.js", "/js/theme.js", "/css/app.css"]) expect((await get(p)).status === 200, `${p} missing`);
});
await check("API needs sign-in once a provider is set up", async () => {
  const status = (await get("/api/questions?open=true")).status;
  expect(health.github || health.gitlab ? status === 401 : status === 200, `status ${status}`);
});
await check("GitHub webhooks refuse an unsigned delivery", async () => {
  const res = await get("/api/webhooks/github", { method: "POST", headers: { "X-GitHub-Event": "ping", "X-GitHub-Delivery": "smoke", "Content-Type": "application/json" }, body: "{}" });
  // 401 when the app has a webhook secret; 404 when GitHub is not set up or its app has no webhook (a localhost tracker).
  expect(health.github && health.webhooks ? res.status === 401 : [401, 404].includes(res.status), `status ${res.status}`);
});
await check("GitLab webhooks refuse a wrong secret", async () => {
  const res = await get("/api/webhooks/gitlab", { method: "POST", headers: { "X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": "smoke", "Content-Type": "application/json" }, body: '{"project":{"id":1}}' });
  expect(res.status === 401, `status ${res.status}`);
});
await check("local folders are refused on a public tracker", async () => {
  if (!https) return;
  expect(health.allowLocal === false, "ALLOW_LOCAL_REPOS is on");
});
await check("unknown API routes return 404", async () => {
  expect((await get("/api/nope")).status === (health.github || health.gitlab ? 401 : 404), "unexpected status");
});

if (health?.webhooks) {
  const { github, gitlab } = health.last7Days;
  console.log(`\nLast 7 days: GitHub ${github.byWebhook} change(s) by webhook, ${github.byPolling} found by polling (missed webhooks); ` +
    `GitLab ${gitlab.byWebhook} by webhook, ${gitlab.byPolling} by polling.`);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
