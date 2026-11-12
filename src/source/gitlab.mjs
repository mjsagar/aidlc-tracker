// Reads one GitLab branch's AI-DLC records through the API, in the same shape as source/github.mjs.
//
// Per poll when nothing changed: branch head (1 request). When the branch moved but aidlc/ did not:
// plus the root tree (1-2 requests). Otherwise the aidlc tree, plus one request per file whose content is new.

import { isTrackedPath } from "../parse/repo.mjs";

const MAX_BYTES = 1024 * 1024;

/**
 * @param {import("../gitlab/client.mjs").GitLabClient} client
 * @param {{token: string, projectId: string, branch: string, lastCommitSha: string|null, lastTreeKey: string|null, force?: boolean,
 *   getBlob(sha: string): string|undefined}} opts
 */
export async function readGitlabBranch(client, { token, projectId, branch, lastCommitSha, lastTreeKey, force = false, getBlob }) {
  const { commitSha } = await client.branchHead(token, projectId, branch);
  if (commitSha === lastCommitSha && lastTreeKey && !force) return { unchanged: true, commitSha };

  const root = await client.tree(token, projectId, { ref: commitSha });
  const aidlc = root.find((e) => e.path === "aidlc" && e.type === "tree");
  const version = root.find((e) => e.path === ".aidlc-version" && e.type === "blob");
  const treeKey = `${aidlc?.id ?? "-"}:${version?.id ?? "-"}`;
  if (treeKey === lastTreeKey && !force) return { unchanged: true, commitSha };

  const blobs = [];
  if (version) blobs.push({ path: ".aidlc-version", sha: version.id });
  if (aidlc) {
    for (const e of await client.tree(token, projectId, { ref: commitSha, path: "aidlc", recursive: true })) {
      if (e.type === "blob") blobs.push({ path: e.path, sha: e.id });
    }
  }

  const entries = [];
  const skipped = [];
  for (const b of blobs) {
    if (!isTrackedPath(b.path)) continue;
    let content = getBlob(b.sha);
    const fetched = content === undefined;
    if (fetched) {
      const blob = await client.blob(token, projectId, b.sha);
      if (blob.size > MAX_BYTES) { skipped.push({ path: b.path, reason: `larger than ${MAX_BYTES} bytes` }); continue; }
      content = blob.content;
    }
    entries.push({ path: b.path, sha: b.sha, content, fetched });
  }
  return { unchanged: false, commitSha, treeKey, entries, skipped };
}
