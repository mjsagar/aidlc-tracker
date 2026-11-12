# Fixtures

## `upstream/`

Copied unchanged from [`awslabs/aidlc-workflows`](https://github.com/awslabs/aidlc-workflows) at the commit in `upstream/COMMIT` (release 2.11.3), under its MIT No Attribution licence (`upstream/LICENSE`).

| Folder | Source in that repo |
| --- | --- |
| `state/` | `tests/fixtures/state-*.md`; `v7-*` from `tests/fixtures/state-v7/` (recorded from a real 2.x run, State Version 7) |
| `questions/` | `tests/fixtures/intent-grounding/{passing,kiro-overclaims}/intent-capture-questions.md` |
| `audit/` | `tests/fixtures/audit-sample.md`, `v05-mr11-bolt-runtime-graph/`, `v05-mr12-learnings/` |
| `memory/` | `core/knowledge/aidlc-shared/memory-template.md`; `memory-mixed.md` and `org-section.md` from `v05-mr12-learnings/` |

## `repos/acme-shop/`

A sample repo laid out the way AI-DLC commits records: `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`. It is assembled from the upstream files plus a few hand-written files that cover cases the upstream samples lack. The hand-written files follow the formats in AI-DLC's `stage-protocol.md` and `audit-format.md`; they were not produced by running AI-DLC.

| Intent | State file | Other files |
| --- | --- | --- |
| `default/261010-todo-bugfix` | upstream `state-mid-inception.md` | Hand-written: questions file (trades, blank and underscore answers, summary confirmation), two audit shards (interleaved, a duplicate timestamp, an unknown event). Upstream `memory-mixed.md` as `memory.md`. |
| `default/261013-sku-totals` | upstream `state-mid-ideation.md` with feasibility changed to `[?]` and a new Project line | Hand-written audit shard with `STAGE_AWAITING_APPROVAL`. Upstream kiro questions file. |
| `default/261020-checkout` | upstream `state-construction.md` with functional design changed to `[R]`, Revision Count 2 | None |
| `default/261104-tempconv` | upstream `v7-aidlc-state-2.3.0-design-approved.md` | Upstream passing questions file |
| `payments/261101-refunds` | upstream `state-corrupted.md` | Hand-written: invalid `project-description.json`, a question with no `[Answer]:` line |

Still to do for milestone 1: replace the hand-written files with records from real AI-DLC runs (one greenfield, one existing-code project).
