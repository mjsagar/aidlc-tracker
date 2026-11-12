# AI-DLC Tracker

Tracks AI-DLC work across repos: unanswered questions, stages waiting for approval, and progress through the phases. It reads the records AI-DLC commits under `aidlc/spaces/` and never writes to a repo.

Design: [AI-DLC Tracker: design](https://claude.ai/artifact/8Ws41qUugWrYiNkkC6DGT5).

**Status:** milestone 1 of 5 (parser and fixtures). It reads local checkouts only; GitHub and GitLab come in milestones 3 and 4. Checked against AI-DLC 2.11.3.

## Use

Requires Node 22.5 or later. No npm dependencies.

```bash
node bin/aidlc-tracker.mjs inbox  path/to/repo [more repos...]   # what is waiting on a person, oldest first
node bin/aidlc-tracker.mjs status path/to/repo                   # one line per piece of work
node bin/aidlc-tracker.mjs snapshot path/to/repo                 # full parsed snapshot as JSON
npm test
```

Add `--json` to `inbox` or `status` for JSON. `npm run inbox` and `npm run status` run against the sample repo in `fixtures/repos/acme-shop`.

## What it reads

| File | Gives |
| --- | --- |
| `**/*-questions.md` | Questions; an `[Answer]:` line holding only spaces or underscores is open (the AI-DLC engine's own rule). The `[<trade>]` after the number says who should answer. |
| `aidlc-state.md` | Phases, stages and their checkboxes: `[?]` waiting for approval, `[R]` being revised |
| `audit/*.md` | Event timeline merged across clones; when a stage started waiting, who approved |
| `**/memory.md` | Softer open questions recorded by the agent |
| `project-description.json` | The original request |
| `.aidlc-version` | Which AI-DLC release the repo uses |

`.aidlc-engine/`, `runtime-graph.json` and `aidlc/.aidlc-sessions/` are not committed by AI-DLC, so they are never read.

## Layout

```
bin/aidlc-tracker.mjs     command-line tool
src/parse/                one parser per file type, plus repo.mjs that builds a snapshot per intent
src/parse/events.mjs      the 134 audit events, generated from the AI-DLC docs
src/source/local.mjs      reads a local checkout into the path -> text Map the parser takes
src/inbox.mjs             inbox and portfolio views across repos
fixtures/                 upstream AI-DLC samples and a sample repo (see fixtures/README.md)
test/                     node:test suite
```

A file the parser cannot fully read never stops a sync: it shows as a warning on that piece of work.
