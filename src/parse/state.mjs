// Parses an AI-DLC `aidlc-state.md` file (docs/guide/10-state-and-audit.md, AI-DLC 2.11.3).
//
//   ## <Section>                     sections
//   - **<Key>**: <value>             fields
//   ### <NAME> PHASE                 phase group under Stage Progress
//   Per unit: <unit>                 following stages belong to that Construction unit
//   - [<box>] <slug> — EXECUTE|SKIP [(reason)]

const SECTION = /^##[ \t]+(.+?)\s*$/;
const FIELD = /^\s*[-*]\s+\*\*(.+?)\*\*:[ \t]*(.*)$/;
const PHASE = /^###[ \t]+(.+?)(?:[ \t]+PHASE)?\s*$/i;
const PER_UNIT = /^Per unit:[ \t]*(.*)$/i;
const STAGE = /^\s*[-*]\s+\[(.)\]\s+([A-Za-z0-9._-]+)\s*(?:[—–-]+\s*(EXECUTE|SKIP)\b[ \t]*(.*))?$/;

export const BOXES = Object.freeze({
  " ": "not-started",
  "-": "in-progress",
  "?": "awaiting-approval",
  R: "revising",
  x: "completed",
  X: "completed",
  S: "skipped",
});

export const PHASES = Object.freeze(["Initialization", "Ideation", "Inception", "Construction", "Operation"]);

const titleCase = (s) => s.trim().toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/**
 * @param {string} text
 * @param {string} [file]
 */
export function parseState(text, file) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections = {};
  const stages = [];
  const warnings = [];
  const warn = (message, line) => warnings.push({ file, line, message });

  let section = null;
  let phase = null;
  let unit = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/<!--.*?-->/g, "");
    const s = SECTION.exec(line);
    if (s) {
      section = s[1];
      sections[section] ??= { fields: {}, lines: [] };
      phase = null;
      unit = null;
      return;
    }
    if (!section) return;
    sections[section].lines.push(raw);

    if (section === "Stage Progress") {
      const p = PHASE.exec(line);
      if (p) { phase = titleCase(p[1]); unit = null; return; }
      const u = PER_UNIT.exec(line.trim());
      if (u) {
        const name = u[1].trim();
        unit = !name || /^\[.*\]$/.test(name) ? null : name; // "[unit-name]" = units not generated yet
        return;
      }
      const st = STAGE.exec(line);
      if (st) {
        const status = BOXES[st[1]] ?? "unknown";
        if (status === "unknown") warn(`Stage "${st[2]}" has an unknown checkbox "[${st[1]}]"`, i + 1);
        stages.push({
          phase,
          unit,
          slug: st[2],
          box: st[1],
          status,
          planned: st[3] ? st[3] === "EXECUTE" : null,
          note: (st[4] ?? "").trim().replace(/^\((.*)\)$/, "$1") || null,
          line: i + 1,
        });
      } else if (/^\s*[-*]\s+\[/.test(line)) {
        warn(`Stage line not understood: "${raw.trim()}"`, i + 1);
      }
      return;
    }

    const f = FIELD.exec(line);
    if (f) sections[section].fields[f[1].trim()] = f[2].trim();
  });

  const field = (sec, key) => {
    const v = sections[sec]?.fields[key];
    return v === undefined || v === "" ? null : v;
  };

  const phases = PHASES.map((name) => ({ name, status: field("Phase Progress", name) }))
    .filter((p) => p.status !== null);
  for (const [name, value] of Object.entries(sections["Phase Progress"]?.fields ?? {})) {
    if (!PHASES.includes(name)) phases.push({ name, status: value || null });
  }

  const revisionCount = Number.parseInt(field("Runtime State", "Revision Count") ?? "", 10);
  const state = {
    project: {
      description: field("Project Information", "Project"),
      type: field("Project Information", "Project Type"),
      scope: field("Project Information", "Scope"),
      plan: field("Project Information", "Plan"),
      startDate: field("Project Information", "Start Date"),
      stateVersion: field("Project Information", "State Version"),
      activeAgent: field("Project Information", "Active Agent"),
    },
    scope: {
      depth: field("Scope Configuration", "Depth"),
      testStrategy: field("Scope Configuration", "Test Strategy"),
      guardPolicy: field("Scope Configuration", "Guard Policy") ?? field("Scope Configuration", "Change Control"),
    },
    current: {
      phase: field("Current Status", "Lifecycle Phase"),
      stage: field("Current Status", "Current Stage"),
      nextStage: field("Current Status", "Next Stage"),
      status: field("Current Status", "Status"),
      lastUpdated: field("Current Status", "Last Updated"),
    },
    resume: {
      lastCompletedStage: field("Session Resume Point", "Last Completed Stage"),
      nextAction: field("Session Resume Point", "Next Action"),
      pendingArtifacts: field("Session Resume Point", "Pending Artifacts"),
    },
    revisionCount: Number.isNaN(revisionCount) ? null : revisionCount,
    phases,
    stages,
    sections,
  };

  if (!sections["Stage Progress"]) warn("State file has no Stage Progress section");
  else if (stages.length === 0) warn("Stage Progress lists no stages");
  if (!state.project.description) warn("Project description is empty");
  if (!state.current.lastUpdated) warn("Last Updated is empty");
  else if (Number.isNaN(Date.parse(state.current.lastUpdated))) warn(`Last Updated is not a date: "${state.current.lastUpdated}"`);

  return { state, warnings };
}

/**
 * Progress as `/aidlc --status` counts it: planned stages after setup
 * (Initialization excluded), skipped stages counted out.
 */
export function progress(stages) {
  const counted = stages.filter((s) => s.phase !== "Initialization" && s.planned !== false && s.status !== "skipped");
  const done = counted.filter((s) => s.status === "completed").length;
  return { done, total: counted.length, percent: counted.length ? Math.round((done / counted.length) * 100) : 0 };
}
