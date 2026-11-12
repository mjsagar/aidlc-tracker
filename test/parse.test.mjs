import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseQuestions, isAnswered } from "../src/parse/questions.mjs";
import { parseState, progress } from "../src/parse/state.mjs";
import { parseAuditShard, mergeAudit } from "../src/parse/audit.mjs";
import { parseMemoryOpenQuestions } from "../src/parse/memory.mjs";
import { KNOWN_EVENTS } from "../src/parse/events.mjs";
import { parseRepo, isTrackedPath, locate } from "../src/parse/repo.mjs";
import { readLocalRepo } from "../src/source/local.mjs";
import { buildInbox, portfolio } from "../src/inbox.mjs";

const up = (dir, f) => readFileSync(new URL(`../fixtures/upstream/${dir}/${f}`, import.meta.url), "utf8");
const upFiles = (dir) => readdirSync(new URL(`../fixtures/upstream/${dir}/`, import.meta.url));
const SAMPLE = new URL("../fixtures/repos/acme-shop", import.meta.url).pathname;

// ---------- questions

test("blank answers follow the engine's rule", () => {
  for (const blank of ["", "   ", "\t", "___", " __ _ "]) assert.equal(isAnswered(blank), false, JSON.stringify(blank));
  for (const filled of ["A", "A, C", "_A_", "Looks correct"]) assert.equal(isAnswered(filled), true, filled);
});

test("upstream questions files parse with every answer read", () => {
  for (const f of upFiles("questions")) {
    const { questions, warnings } = parseQuestions(up("questions", f), f);
    assert.deepEqual(warnings, [], f);
    assert.equal(questions.length, 8, f);
    assert.ok(questions.every((q) => !q.open && q.answer), f);
  }
  const { questions } = parseQuestions(up("questions", "passing-intent-capture-questions.md"));
  assert.equal(questions[0].number, 1);
  assert.equal(questions[0].title, "What business problem are we solving?");
  assert.deepEqual(questions[0].options.map((o) => o.key), ["A", "X"]);
  assert.equal(questions[0].answer, "A. Echo supplied text locally.");
});

test("trade, multi-select, summary and open answers in the sample questions file", () => {
  const text = readFileSync(`${SAMPLE}/aidlc/spaces/default/intents/261010-todo-bugfix/inception/requirements-analysis/requirements-analysis-questions.md`, "utf8");
  const { questions, warnings } = parseQuestions(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(questions.map((q) => [q.kind, q.number, q.trade, q.open]), [
    ["question", 1, "Product owner", false],
    ["question", 2, "Product owner", true],
    ["question", 3, "Developer", true],
    ["question", 4, "Operations engineer", true],
    ["summary", null, null, true],
  ]);
  assert.equal(questions[2].multiSelect, true);
  assert.equal(questions[0].multiSelect, false);
  assert.deepEqual(questions[4].options.map((o) => o.text), ["Looks correct", "Request changes"]);
  assert.match(questions[2].prompt, /localStorage/);
});

test("a question with no [Answer]: line is open and warned about; Sources is not a question", () => {
  const { questions, warnings } = parseQuestions("# Q\n\n## Sources\n\n- [desc] x\n\n## Q1. Who?\n\n- A. Me\n");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].open, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /no \[Answer\]: line/);
});

test("CRLF line endings and a second [Answer]: line", () => {
  const { questions, warnings } = parseQuestions("## Q1. A?\r\n\r\n[Answer]: B\r\n[Answer]: C\r\n");
  assert.equal(questions[0].answer, "B");
  assert.match(warnings[0].message, /2 \[Answer\]: lines/);
});

// ---------- state

test("every upstream state file parses; only the corrupted one warns", () => {
  for (const f of upFiles("state")) {
    const { state, warnings } = parseState(up("state", f), f);
    if (f === "state-corrupted.md") {
      assert.deepEqual(warnings.map((w) => w.message), [
        "State file has no Stage Progress section", "Project description is empty", "Last Updated is empty"]);
      assert.equal(state.stages.length, 0);
    } else {
      assert.deepEqual(warnings, [], f);
      assert.ok(state.stages.length > 0, f);
      assert.ok(state.stages.every((s) => s.status !== "unknown"), f);
    }
  }
});

test("mid-inception state: fields, phases, stages, progress", () => {
  const { state } = parseState(up("state", "state-mid-inception.md"));
  assert.equal(state.project.scope, "bugfix");
  assert.equal(state.scope.guardPolicy, "strict (from scope bugfix)"); // retired Change Control line
  assert.equal(state.current.stage, "requirements-analysis");
  assert.equal(state.current.lastUpdated, "2025-07-15T10:30:00Z");
  assert.deepEqual(state.phases.map((p) => p.status), ["Verified", "Verified", "Active", "Pending", "Pending"]);
  const ra = state.stages.find((s) => s.slug === "requirements-analysis");
  assert.deepEqual([ra.phase, ra.status, ra.planned], ["Inception", "in-progress", true]);
  const ic = state.stages.find((s) => s.slug === "intent-capture");
  assert.deepEqual([ic.planned, ic.note], [false, "bugfix scope"]);
  assert.deepEqual(progress(state.stages), { done: 1, total: 6, percent: 17 });
});

test("per-unit Construction stages carry their unit; the [unit-name] placeholder does not", () => {
  const { state } = parseState(up("state", "state-construction.md"));
  const units = [...new Set(state.stages.filter((s) => s.phase === "Construction").map((s) => s.unit))];
  assert.deepEqual(units, ["widget-cart", "widget-checkout"]);
  const { state: s2 } = parseState(up("state", "state-mid-inception.md"));
  assert.ok(s2.stages.filter((s) => s.phase === "Construction").every((s) => s.unit === null));
});

test("all six checkboxes, skipped stages counted out", () => {
  const text = "## Stage Progress\n### IDEATION PHASE\n- [x] a — EXECUTE\n- [-] b — EXECUTE\n- [?] c — EXECUTE\n" +
    "- [R] d — EXECUTE\n- [S] e — EXECUTE\n- [ ] f — SKIP (scope)\n- [ ] g – EXECUTE\n- [Q] h — EXECUTE\n";
  const { state, warnings } = parseState(text);
  assert.deepEqual(state.stages.map((s) => s.status),
    ["completed", "in-progress", "awaiting-approval", "revising", "skipped", "not-started", "not-started", "unknown"]);
  assert.ok(warnings.some((w) => /unknown checkbox "\[Q\]"/.test(w.message)));
  assert.deepEqual(progress(state.stages), { done: 1, total: 6, percent: 17 });
});

test("a completed workflow is 100%", () => {
  const { state } = parseState(up("state", "state-completed.md"));
  assert.deepEqual(progress(state.stages), { done: 30, total: 30, percent: 100 });
});

// ---------- audit

test("the event list matches the documented 134-event taxonomy", () => {
  assert.equal(KNOWN_EVENTS.size, 134);
  for (const e of ["STAGE_AWAITING_APPROVAL", "GATE_APPROVED", "QUESTION_ANSWERED", "RECOMPOSED", "SOURCE_COMMITTED"]) assert.ok(KNOWN_EVENTS.has(e), e);
});

test("every upstream audit sample parses with only known events", () => {
  for (const f of upFiles("audit")) {
    const { events, warnings } = parseAuditShard(up("audit", f), f);
    assert.deepEqual(warnings, [], f);
    assert.ok(events.length > 0, f);
    assert.ok(events.every((e) => e.known && e.at !== null), f);
  }
});

test("audit blocks: header skipped, first timestamp wins, unknown events kept, escapes undone", () => {
  const dir = `${SAMPLE}/aidlc/spaces/default/intents/261010-todo-bugfix/audit`;
  const { events } = mergeAudit(readdirSync(dir).map((name) => ({ name, text: readFileSync(`${dir}/${name}`, "utf8") })));
  assert.deepEqual(events.map((e) => e.event), [
    "WORKFLOW_STARTED", "STAGE_STARTED", "GATE_APPROVED", "STAGE_COMPLETED", "STAGE_STARTED",
    "ARTIFACT_CREATED", "DECISION_RECORDED", "SOMETHING_NEW_IN_A_LATER_RELEASE", "QUESTION_ANSWERED"]);
  const odd = events.find((e) => e.event === "SOMETHING_NEW_IN_A_LATER_RELEASE");
  assert.equal(odd.known, false);
  assert.equal(odd.timestamp, "2025-07-15T10:27:00Z");
  assert.equal(events.find((e) => e.event === "GATE_APPROVED").gitName, "Priya Shah");
  assert.equal(events.at(-1).fields["Person Reply"], "every todo please\nopen and done");
});

test("ties across shards are marked unordered; missing timestamps go last with a warning", () => {
  const block = (t, e) => `## X\n**Timestamp**: ${t}\n**Event**: ${e}\n`;
  const { events, warnings } = mergeAudit([
    { name: "b.md", text: block("2026-01-01T00:00:00Z", "STAGE_STARTED") },
    { name: "a.md", text: [block("2026-01-01T00:00:00Z", "SESSION_STARTED"), block("nope", "SESSION_ENDED")].join("---\n") },
  ]);
  assert.deepEqual(events.map((e) => [e.shard, e.event, e.unordered]), [
    ["a.md", "SESSION_STARTED", true], ["b.md", "STAGE_STARTED", true], ["a.md", "SESSION_ENDED", false]]);
  assert.equal(warnings.length, 1);
});

// ---------- memory

test("memory.md open questions; template examples ignored", () => {
  assert.deepEqual(parseMemoryOpenQuestions(up("memory", "memory-mixed.md")).map((n) => [n.at, n.text]),
    [["2026-05-28T15:01:02Z", "Confirm whether story splitting is by persona or by journey"]]);
  assert.deepEqual(parseMemoryOpenQuestions(up("memory", "memory-template.md")), []);
});

// ---------- repo

test("tracked paths: records only, never engine or session files", () => {
  const p = "aidlc/spaces/default/intents/261010-x/";
  for (const ok of [".aidlc-version", `${p}aidlc-state.md`, `${p}project-description.json`, `${p}audit/mac-1.md`,
    `${p}inception/requirements-analysis/requirements-analysis-questions.md`, `${p}inception/requirements-analysis/memory.md`]) assert.ok(isTrackedPath(ok), ok);
  for (const no of [`${p}runtime-graph.json`, `${p}.aidlc-engine/plan.json`, `${p}inception/requirements-analysis/requirements.md`,
    "aidlc/.aidlc-sessions/x.json", "aidlc/spaces/default/memory/project.md", "src/app.ts"]) assert.ok(!isTrackedPath(no), no);
});

test("locate: phase, stage and unit from a record path", () => {
  assert.deepEqual(locate("inception/requirements-analysis/requirements-analysis-questions.md"), { phase: "Inception", unit: null, stage: "requirements-analysis" });
  assert.deepEqual(locate("construction/widget-checkout/functional-design/functional-design-questions.md"), { phase: "Construction", unit: "widget-checkout", stage: "functional-design" });
  assert.deepEqual(locate("feasibility-questions.md"), { phase: null, unit: null, stage: "feasibility" });
});

test("sample repo: five intents across two spaces, with the right blockers and questions", () => {
  const { files, skipped } = readLocalRepo(SAMPLE);
  assert.deepEqual(skipped, []);
  const snap = parseRepo(files);
  assert.equal(snap.aidlcVersion, "2.11.3");
  assert.deepEqual(snap.intents.map((i) => i.id), [
    "default/261010-todo-bugfix", "default/261013-sku-totals", "default/261020-checkout", "default/261104-tempconv", "payments/261101-refunds"]);
  const by = Object.fromEntries(snap.intents.map((i) => [i.folder, i]));

  const todo = by["261010-todo-bugfix"];
  assert.equal(todo.createdOn, "2026-10-10");
  assert.equal(todo.descriptionSource, "project-description.json");
  assert.equal(todo.openQuestionCount, 3);
  assert.ok(todo.questions.filter((q) => q.open).every((q) => q.openSince === "2025-07-15T10:25:00Z"));
  assert.deepEqual(todo.approvals, [{ stage: "reverse-engineering", unit: null, gitName: "Priya Shah", at: "2025-07-15T10:20:00Z" }]);
  assert.equal(todo.notes.length, 1);
  assert.equal(todo.lastActivity, "2025-07-15T10:30:00Z");
  assert.deepEqual(todo.warnings, []);

  assert.deepEqual(by["261013-sku-totals"].blockers, [{ type: "awaiting-approval", phase: "Ideation", unit: null, stage: "feasibility",
    since: "2026-10-13T10:43:59Z", sinceSource: "audit", revisionCount: null }]);
  assert.deepEqual(by["261020-checkout"].blockers, [{ type: "revising", phase: "Construction", unit: "widget-checkout", stage: "functional-design",
    since: "2025-06-18T14:20:00Z", sinceSource: "state", revisionCount: 2 }]);

  const tc = by["261104-tempconv"];
  assert.equal(tc.openQuestionCount, 0);
  assert.equal(tc.project.stateVersion, "7");
  assert.deepEqual(tc.warnings, []);

  const refunds = by["261101-refunds"];
  assert.equal(refunds.description, null);
  assert.equal(refunds.warnings.length, 5);
  assert.ok(refunds.warnings.every((w) => w.file.startsWith("aidlc/spaces/payments/intents/261101-refunds/")));
});

test("inbox lists everything waiting, oldest first; portfolio has a row per intent", () => {
  const { files } = readLocalRepo(SAMPLE);
  const repos = [{ repo: "acme-shop", snapshot: parseRepo(files) }];
  const inbox = buildInbox(repos);
  assert.deepEqual(inbox.map((i) => [i.intent, i.type]), [
    ["default/261020-checkout", "revising"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "question"],
    ["default/261010-todo-bugfix", "summary"],
    ["default/261013-sku-totals", "awaiting-approval"],
    ["payments/261101-refunds", "question"],
  ]);
  assert.equal(inbox[1].trade, "Product owner");
  assert.equal(inbox[1].line, 26);
  const rows = portfolio(repos);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.find((r) => r.intent === "default/261013-sku-totals"), {
    repo: "acme-shop", intent: "default/261013-sku-totals", description: "Show one stock total per SKU across warehouses",
    phase: "IDEATION", stage: "feasibility", status: "Running", done: 2, total: 30, openQuestions: 0, waiting: 1,
    lastActivity: "2026-10-13T10:43:59Z", warnings: 0 });
});

test("CLI: inbox, status and JSON output run", () => {
  const cli = new URL("../bin/aidlc-tracker.mjs", import.meta.url).pathname;
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(run("inbox", SAMPLE), /7 items waiting\./);
  assert.match(run("status", SAMPLE), /1 of 6 stages done; 3 open questions/);
  assert.equal(JSON.parse(run("inbox", SAMPLE, "--json")).length, 7);
  assert.equal(JSON.parse(run("snapshot", SAMPLE)).intents.length, 5);
  assert.throws(() => run("nonsense"), (e) => e.status === 2);
});
