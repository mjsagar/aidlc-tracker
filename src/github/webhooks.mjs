// GitHub webhook receiver: verify, de-duplicate, queue. The work itself runs from the queue.

import { verifyGithubSignature } from "../secrets.mjs";
import { enqueue, enqueueBackfill, removeInstallation, upsertInstallation } from "../sync.mjs";

const ZERO_SHA = /^0+$/;

/**
 * @param {{db: import("node:sqlite").DatabaseSync, webhookSecret: () => string|null}} ctx
 * @param {{event?: string, delivery?: string, signature?: string, raw: Buffer}} req
 * @returns {{status: number, body: object}}
 */
export function handleGithubWebhook(ctx, { event, delivery, signature, raw }) {
  const { db } = ctx;
  const secret = ctx.webhookSecret();
  if (!secret) return { status: 404, body: { error: "GitHub is not set up" } };
  if (!verifyGithubSignature(secret, raw, signature)) return { status: 401, body: { error: "Bad signature" } };
  if (!delivery || !event) return { status: 400, body: { error: "Missing delivery or event header" } };

  const fresh = db.prepare("INSERT OR IGNORE INTO deliveries (id, platform, event) VALUES (?, 'github', ?)").run(delivery, event).changes > 0;
  db.prepare("DELETE FROM deliveries WHERE received_at < ?").run(new Date(Date.now() - 14 * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z"));
  if (!fresh) return { status: 200, body: { duplicate: true } };

  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return { status: 400, body: { error: "Invalid JSON" } }; }

  const install = payload.installation;
  if (event === "ping") return { status: 200, body: { ok: true } };

  if (event === "installation") {
    if (["deleted", "suspend"].includes(payload.action)) {
      removeInstallation(db, install.id);
      return { status: 200, body: { removed: true } };
    }
    const id = upsertInstallation(db, { installationId: install.id, account: install.account?.login ?? null });
    enqueueBackfill(db, id, `installation.${payload.action}`);
    return { status: 202, body: { queued: "backfill" } };
  }

  if (event === "installation_repositories") {
    const id = upsertInstallation(db, { installationId: install.id, account: install.account?.login ?? null });
    enqueueBackfill(db, id, `installation_repositories.${payload.action}`);
    return { status: 202, body: { queued: "backfill" } };
  }

  if (event === "push") {
    const ref = String(payload.ref ?? "");
    if (!ref.startsWith("refs/heads/") || ZERO_SHA.test(payload.after ?? "")) return { status: 200, body: { ignored: "not a branch update" } };
    const branchName = ref.slice("refs/heads/".length);
    const rows = db.prepare(`SELECT b.id FROM branches b JOIN repos r ON r.id = b.repo_id JOIN connections c ON c.id = r.connection_id
      WHERE c.platform = 'github' AND c.external_id = ? AND r.platform_repo_id = ? AND b.name = ? AND b.tracked = 1 AND r.tracked = 1`)
      .all(String(install?.id ?? ""), String(payload.repository?.id ?? ""), branchName);
    for (const r of rows) enqueue(db, r.id, "push");
    return { status: rows.length ? 202 : 200, body: rows.length ? { queued: rows.length } : { ignored: "branch not tracked" } };
  }

  return { status: 200, body: { ignored: event } };
}
