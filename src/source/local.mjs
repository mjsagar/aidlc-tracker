// Reads a repo's AI-DLC records from a local checkout into the Map parseRepo() takes.

import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isTrackedPath } from "../parse/repo.mjs";

const MAX_BYTES = 1024 * 1024; // AI-DLC itself refuses record files over 1 MiB
const SKIP_DIRS = new Set([".aidlc-engine", ".aidlc-sessions", ".git", "node_modules"]);

/**
 * @param {string} root  repo checkout
 * @returns {{files: Map<string,string>, skipped: {path: string, reason: string}[]}}
 */
export function readLocalRepo(root) {
  const files = new Map();
  const skipped = [];
  const take = (abs) => {
    const rel = relative(root, abs).split(sep).join("/");
    if (!isTrackedPath(rel)) return;
    const st = lstatSync(abs);
    if (!st.isFile()) return skipped.push({ path: rel, reason: "not a regular file" });
    if (st.size > MAX_BYTES) return skipped.push({ path: rel, reason: `larger than ${MAX_BYTES} bytes` });
    files.set(rel, readFileSync(abs, "utf8"));
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(abs); }
      else if (entry.isFile()) take(abs);
    }
  };
  if (existsSync(join(root, ".aidlc-version"))) take(join(root, ".aidlc-version"));
  if (existsSync(join(root, "aidlc", "spaces"))) walk(join(root, "aidlc", "spaces"));
  return { files, skipped };
}
