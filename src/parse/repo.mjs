// Turns the AI-DLC files of one repo (a Map of repo-relative path -> text) into
// one snapshot per intent. Platform-free: the local-folder reader, and later the
// GitHub and GitLab adapters, only have to supply the Map.

import { parseQuestions } from "./questions.mjs";
import { parseState, progress } from "./state.mjs";
import { mergeAudit } from "./audit.mjs";
import { parseMemoryOpenQuestions } from "./memory.mjs";
import { PARSER_VERSION } from "../version.mjs";

const RECORD = /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)\/(.+)$/;
const INTENT_FOLDER = /^(\d{2})(\d{2})(\d{2})-(.+)$/;

/** Which paths a reader needs to fetch: committed AI-DLC records only. */
export function isTrackedPath(path) {
  if (path === ".aidlc-version") return true;
  const m = RECORD.exec(path);
  if (!m) return false;
  const rel = m[3];
  if (rel.startsWith(".aidlc-engine/") || rel.includes("/.aidlc-engine/")) return false;
  if (rel === "runtime-graph.json") return false;
  return rel === "aidlc-state.md" || rel === "project-description.json" ||
    rel.startsWith("audit/") && rel.endsWith(".md") ||
    rel.endsWith("-questions.md") || rel.endsWith("/memory.md");
}

/**
 * @param {Map<string, string>} files repo-relative path (forward slashes) -> text
 */
export function parseRepo(files) {
  const groups = new Map();
  for (const [path, text] of files) {
    const m = RECORD.exec(path);
    if (!m || !isTrackedPath(path)) continue;
    const key = `${m[1]}/${m[2]}`;
    if (!groups.has(key)) groups.set(key, { space: m[1], folder: m[2], files: new Map() });
    groups.get(key).files.set(m[3], text);
  }
  const intents = [...groups.values()]
    .map((g) => parseIntent(g.space, g.folder, g.files))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    parserVersion: PARSER_VERSION,
    aidlcVersion: files.get(".aidlc-version")?.trim() || null,
    intents,
  };
}

/** Where a record-relative path sits: phase, stage and Construction unit. */
export function locate(rel) {
  const parts = rel.split("/");
  const name = parts.at(-1);
  const fromName = name.replace(/-questions\.md$/, "").replace(/\.md$/, "");
  if (parts[0] === "construction" && parts.length >= 4) return { phase: "Construction", unit: parts[1], stage: parts[2] };
  if (parts.length >= 3) return { phase: cap(parts[0]), unit: null, stage: parts[1] };
  if (parts.length === 2) return { phase: cap(parts[0]), unit: null, stage: fromName };
  return { phase: null, unit: null, stage: fromName };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function parseIntent(space, folder, files) {
  const base = `aidlc/spaces/${space}/intents/${folder}`;
  const warnings = [];
  const addWarnings = (list, rel) => warnings.push(...list.map((w) => ({ ...w, file: `${base}/${w.file ?? rel}` })));

  // Audit first: other parts read times from it.
  const shards = [...files].filter(([rel]) => rel.startsWith("audit/")).map(([rel, text]) => ({ name: rel.slice(6), text }));
  const audit = mergeAudit(shards);
  addWarnings(audit.warnings.map((w) => ({ ...w, file: `audit/${w.file}` })));
  const events = audit.events;
  const latest = (pred) => events.filter(pred).at(-1) ?? null;

  // State.
  const stateText = files.get("aidlc-state.md");
  let state = null;
  if (stateText === undefined) warnings.push({ file: `${base}/aidlc-state.md`, message: "No aidlc-state.md in this intent folder" });
  else {
    const parsed = parseState(stateText, "aidlc-state.md");
    state = parsed.state;
    addWarnings(parsed.warnings, "aidlc-state.md");
  }

  // Description: project-description.json, else the state file's single-line preview.
  let description = state?.project.description ?? null;
  let descriptionSource = description ? "state" : null;
  const descText = files.get("project-description.json");
  if (descText !== undefined) {
    try {
      const value = JSON.parse(descText);
      if (typeof value === "string" && value.trim()) { description = value.trim(); descriptionSource = "project-description.json"; }
      else throw new Error("not a string");
    } catch {
      warnings.push({ file: `${base}/project-description.json`, message: "project-description.json is not a JSON string; using the state file's Project line" });
    }
  }

  // Blockers: stages waiting on a person.
  const stages = state?.stages ?? [];
  // An event belongs to a stage row when the stage matches and, for a Construction
  // unit's row, the event names that unit or no unit at all.
  const sameStage = (s) => (e) => e.stage === s.slug && (s.unit === null || e.unit === null || e.unit === s.unit);
  const blockers = stages.filter((s) => s.status === "awaiting-approval" || s.status === "revising").map((s) => {
    const ev = s.status === "awaiting-approval"
      ? latest((e) => e.event === "STAGE_AWAITING_APPROVAL" && sameStage(s)(e))
      : latest((e) => (e.event === "STAGE_REVISING" || e.event === "GATE_REJECTED") && sameStage(s)(e));
    return {
      type: s.status,
      phase: s.phase,
      unit: s.unit,
      stage: s.slug,
      since: ev?.timestamp ?? state?.current.lastUpdated ?? null,
      sinceSource: ev ? "audit" : "state",
      revisionCount: s.status === "revising" ? state?.revisionCount ?? null : null,
    };
  });

  // Questions files and memory notes.
  const questions = [];
  const notes = [];
  for (const [rel, text] of files) {
    if (rel.endsWith("-questions.md")) {
      const parsed = parseQuestions(text, rel);
      addWarnings(parsed.warnings, rel);
      const where = locate(rel);
      const created = latest((e) => e.event === "ARTIFACT_CREATED" && typeof e.fields.File === "string" &&
        (e.fields.File === `${base}/${rel}` || e.fields.File.endsWith(`/${base}/${rel}`)));
      for (const q of parsed.questions) {
        questions.push({ ...q, file: `${base}/${rel}`, ...where, openSince: q.open ? created?.timestamp ?? null : null });
      }
    } else if (rel.endsWith("memory.md")) {
      const where = locate(rel);
      for (const n of parseMemoryOpenQuestions(text)) notes.push({ ...n, file: `${base}/${rel}`, ...where });
    }
  }
  questions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const approvals = events.filter((e) => e.event === "GATE_APPROVED")
    .map((e) => ({ stage: e.stage, unit: e.unit, gitName: e.gitName, at: e.timestamp }));

  const times = [...events.map((e) => e.at), Date.parse(state?.current.lastUpdated ?? "")].filter(Number.isFinite);
  const lastActivity = times.length ? new Date(Math.max(...times)).toISOString().replace(".000Z", "Z") : null;

  const m = INTENT_FOLDER.exec(folder);
  const openQuestions = questions.filter((q) => q.open);
  return {
    id: `${space}/${folder}`,
    space,
    folder,
    path: base,
    label: m ? m[4] : folder,
    createdOn: m ? `20${m[1]}-${m[2]}-${m[3]}` : null,
    description,
    descriptionSource,
    project: state?.project ?? null,
    scope: state?.scope ?? null,
    current: state?.current ?? null,
    phases: state?.phases ?? [],
    stages: stages.map(({ phase, unit, slug, status, planned, note }) => ({ phase, unit, slug, status, planned, note })),
    progress: progress(stages),
    blockers,
    questions,
    openQuestionCount: openQuestions.filter((q) => q.kind === "question").length,
    notes,
    approvals,
    events,
    lastActivity,
    warnings,
  };
}
