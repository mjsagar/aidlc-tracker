// Everything waiting on a person, across repos: open questions, unconfirmed
// answer summaries, stages awaiting approval, stages being revised.

const ORDER = { "awaiting-approval": 0, revising: 1, question: 2, summary: 3 };

/**
 * @param {{repo: string, snapshot: ReturnType<import("./parse/repo.mjs").parseRepo>}[]} repos
 */
export function buildInbox(repos) {
  const items = [];
  for (const { repo, snapshot } of repos) {
    for (const intent of snapshot.intents) {
      const where = { repo, intent: intent.id, intentLabel: intent.label };
      for (const b of intent.blockers) {
        items.push({ ...where, type: b.type, phase: b.phase, unit: b.unit, stage: b.stage, since: b.since,
          title: b.type === "awaiting-approval" ? "Waiting for approval" : `Being revised${b.revisionCount ? ` (revision ${b.revisionCount})` : ""}`,
          trade: null, file: `${intent.path}/aidlc-state.md`, line: null });
      }
      for (const q of intent.questions.filter((x) => x.open)) {
        items.push({ ...where, type: q.kind, phase: q.phase, unit: q.unit, stage: q.stage, since: q.openSince,
          title: q.kind === "summary" ? "Confirm the summary of answers" : `Q${q.number ?? "?"}. ${q.title}`,
          trade: q.trade, file: q.file, line: q.answerLine ?? q.line });
      }
    }
  }
  const t = (s) => { const v = Date.parse(s ?? ""); return Number.isNaN(v) ? Infinity : v; };
  return items.sort((a, b) => t(a.since) - t(b.since) || ORDER[a.type] - ORDER[b.type] ||
    a.repo.localeCompare(b.repo) || a.intent.localeCompare(b.intent) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}

/** One portfolio row per intent. */
export function portfolio(repos) {
  return repos.flatMap(({ repo, snapshot }) => snapshot.intents.map((i) => ({
    repo,
    intent: i.id,
    description: i.description,
    phase: i.current?.phase ?? null,
    stage: i.current?.stage ?? null,
    status: i.current?.status ?? null,
    done: i.progress.done,
    total: i.progress.total,
    openQuestions: i.openQuestionCount,
    waiting: i.blockers.length,
    lastActivity: i.lastActivity,
    warnings: i.warnings.length,
  })));
}
