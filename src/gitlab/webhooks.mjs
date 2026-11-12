// GitLab webhook receiver. GitLab sends the secret token as `X-Gitlab-Token` (no signature);
// it is compared in constant time with the secret the tracker generated for that connection.

import { decrypt, safeEqual } from "../secrets.mjs";
import { enqueue } from "../sync.mjs";

const ZERO_SHA = /^0+$/;

/**
 * @param {{db: import("node:sqlite").DatabaseSync, key: Buffer}} ctx
 * @param {{event?: string, uuid?: string, token?: string, raw: Buffer}} req
 * @returns {{status: number, body: object}}
 */
export function handleGitlabWebhook(ctx, { event, uuid, token, raw }) {
  const { db, key } = ctx;
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return { status: 400, body: { error: "Invalid JSON" } }; }
  const projectId = String(payload.project?.id ?? payload.project_id ?? "");

  // Find the connection(s) tracking this project and check the secret against theirs.
  const rows = db.prepare(`SELECT r.id AS repo_id, c.webhook_secret FROM repos r JOIN connections c ON c.id = r.connection_id
    WHERE c.platform = 'gitlab' AND r.platform_repo_id = ?`).all(projectId);
  const allowed = rows.filter((r) => r.webhook_secret && safeEqual(decrypt(key, r.webhook_secret), token));
  if (!allowed.length) return { status: 401, body: { error: "Unknown project or wrong secret token" } };

  if (uuid) {
    const fresh = db.prepare("INSERT OR IGNORE INTO deliveries (id, platform, event) VALUES (?, 'gitlab', ?)").run(`gitlab:${uuid}`, event ?? null).changes > 0;
    if (!fresh) return { status: 200, body: { duplicate: true } };
  }

  if (event !== "Push Hook") return { status: 200, body: { ignored: event ?? "no event" } };
  const ref = String(payload.ref ?? "");
  if (!ref.startsWith("refs/heads/") || ZERO_SHA.test(payload.after ?? payload.checkout_sha ?? "")) return { status: 200, body: { ignored: "not a branch update" } };
  const branchName = ref.slice("refs/heads/".length);
  let queued = 0;
  for (const r of allowed) {
    for (const b of db.prepare("SELECT id FROM branches WHERE repo_id = ? AND name = ? AND tracked = 1").all(r.repo_id, branchName)) {
      enqueue(db, b.id, "push");
      queued += 1;
    }
  }
  return { status: queued ? 202 : 200, body: queued ? { queued } : { ignored: "branch not tracked" } };
}
