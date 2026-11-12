#!/usr/bin/env node
// aidlc-tracker: read AI-DLC records from local repo checkouts.
//
//   aidlc-tracker inbox <repo>...      what is waiting on a person, oldest first
//   aidlc-tracker status <repo>...     one line per piece of work
//   aidlc-tracker snapshot <repo>      full parsed snapshot as JSON
//   add --json to inbox or status for JSON output

import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readLocalRepo } from "../src/source/local.mjs";
import { parseRepo } from "../src/parse/repo.mjs";
import { buildInbox, portfolio } from "../src/inbox.mjs";

const USAGE = `Usage:
  aidlc-tracker inbox <repo>... [--json]
  aidlc-tracker status <repo>... [--json]
  aidlc-tracker snapshot <repo>`;

const args = process.argv.slice(2);
const json = args.includes("--json");
const [command, ...paths] = args.filter((a) => a !== "--json");

if (!command || command === "--help" || command === "-h" || !["inbox", "status", "snapshot"].includes(command) || paths.length === 0) {
  console.error(USAGE);
  process.exit(command === "--help" || command === "-h" ? 0 : 2);
}

const repos = paths.map((p) => {
  const root = resolve(p);
  if (!existsSync(root)) { console.error(`Not found: ${p}`); process.exit(2); }
  const { files, skipped } = readLocalRepo(root);
  for (const s of skipped) console.error(`Skipped ${s.path}: ${s.reason}`);
  return { repo: basename(root), snapshot: parseRepo(files) };
});

const warnings = repos.flatMap(({ repo, snapshot }) => snapshot.intents.flatMap((i) => i.warnings.map((w) => ({ repo, ...w }))));
const day = (s) => (s ? s.slice(0, 16).replace("T", " ") : "unknown");
const humanStage = (s) => (s ? s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");

if (command === "snapshot") {
  console.log(JSON.stringify(repos.length === 1 ? repos[0].snapshot : repos, null, 2));
} else if (command === "inbox") {
  const items = buildInbox(repos);
  if (json) console.log(JSON.stringify(items, null, 2));
  else {
    if (items.length === 0) console.log("Nothing is waiting on anyone.");
    let lastIntent = null;
    for (const it of items) {
      const head = `${it.repo} ${it.intent}`;
      if (head !== lastIntent) { console.log(`\n${head}`); lastIntent = head; }
      const where = [humanStage(it.stage), it.unit && `unit ${it.unit}`].filter(Boolean).join(", ");
      const who = it.trade ? ` [${it.trade}]` : "";
      console.log(`  ${it.title}${who}`);
      console.log(`    ${where}; since ${day(it.since)}; ${it.file}${it.line ? `:${it.line}` : ""}`);
    }
    console.log(`\n${items.length} item${items.length === 1 ? "" : "s"} waiting.`);
  }
} else {
  const rows = portfolio(repos);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) {
    console.log(`${r.repo} ${r.intent}`);
    console.log(`  ${r.description ?? "(no description)"}`);
    console.log(`  ${r.phase ?? "?"} / ${humanStage(r.stage) || "?"} (${r.status ?? "?"}); ${r.done} of ${r.total} stages done; ` +
      `${r.openQuestions} open question${r.openQuestions === 1 ? "" : "s"}; ${r.waiting} waiting for a person; last activity ${day(r.lastActivity)}`);
  }
}

if (!json && command !== "snapshot" && warnings.length) {
  console.error(`\n${warnings.length} warning${warnings.length === 1 ? "" : "s"}:`);
  for (const w of warnings) console.error(`  ${w.repo} ${w.file}${w.line ? `:${w.line}` : ""}: ${w.message}`);
}
