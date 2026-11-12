// Reads one GitHub branch's AI-DLC records through the API.
//
// Cost per poll when nothing changed: one conditional request (304, free).
// When the branch moved but `aidlc/` did not: two requests (branch + root tree).
// Otherwise: the aidlc tree, plus one blob request per file whose content is new.

import { isTrackedPath } from "../parse/repo.mjs";

const MAX_BYTES = 1024 * 1024;

/**
 * @param {import("../github/client.mjs").GitHubClient} client
 * @param {{installationId: string, fullName: string, branch: string, lastTreeKey: string|null, force?: boolean,
 *   getBlob(sha: string): string|undefined}} opts
 * @returns {Promise<{unchanged: true, commitSha: string} | {unchanged: false, commitSha: string, treeKey: string,
 *   entries: {path: string, sha: string, content: string, fetched: boolean}[], skipped: {path: string, reason: string}[]}>}
 */
export async function readGithubBranch(client, { installationId, fullName, branch, lastTreeKey, force = false, getBlob }) {
  const head = await client.branchHead(installationId, fullName, branch);
  if (head.notModified && lastTreeKey && !force) return { unchanged: true, commitSha: head.commitSha };

  const root = await client.tree(installationId, fullName, head.treeSha);
  const aidlc = root.tree.find((e) => e.path === "aidlc" && e.type === "tree");
  const version = root.tree.find((e) => e.path === ".aidlc-version" && e.type === "blob");
  const treeKey = `${aidlc?.sha ?? "-"}:${version?.sha ?? "-"}`;
  if (treeKey === lastTreeKey && !force) return { unchanged: true, commitSha: head.commitSha };

  const blobs = [];
  if (version) blobs.push({ path: ".aidlc-version", sha: version.sha, size: version.size });
  if (aidlc) {
    const walked = await walk(client, installationId, fullName, aidlc.sha, "aidlc");
    blobs.push(...walked);
  }

  const entries = [];
  const skipped = [];
  for (const b of blobs) {
    if (!isTrackedPath(b.path)) continue;
    if (b.size > MAX_BYTES) { skipped.push({ path: b.path, reason: `larger than ${MAX_BYTES} bytes` }); continue; }
    let content = getBlob(b.sha);
    const fetched = content === undefined;
    if (fetched) content = await client.blob(installationId, fullName, b.sha);
    entries.push({ path: b.path, sha: b.sha, content, fetched });
  }
  return { unchanged: false, commitSha: head.commitSha, treeKey, entries, skipped };
}

// Recursive tree listing; when GitHub truncates a large tree, falls back to walking subtrees one by one.
async function walk(client, installationId, fullName, sha, prefix) {
  const t = await client.tree(installationId, fullName, sha, true);
  if (!t.truncated) {
    return t.tree.filter((e) => e.type === "blob").map((e) => ({ path: `${prefix}/${e.path}`, sha: e.sha, size: e.size ?? 0 }));
  }
  const out = [];
  const shallow = await client.tree(installationId, fullName, sha, false);
  for (const e of shallow.tree) {
    if (e.type === "blob") out.push({ path: `${prefix}/${e.path}`, sha: e.sha, size: e.size ?? 0 });
    else if (e.type === "tree" && e.path !== ".aidlc-engine" && e.path !== ".aidlc-sessions") {
      out.push(...await walk(client, installationId, fullName, e.sha, `${prefix}/${e.path}`));
    }
  }
  return out;
}
