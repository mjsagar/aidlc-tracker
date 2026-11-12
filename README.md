# AI-DLC Tracker

Tracks AI-DLC work across repos: unanswered questions, stages waiting for approval, and progress through the phases. It reads the records AI-DLC commits under `aidlc/spaces/` and never writes to a repo.

Design: [AI-DLC Tracker: design](https://claude.ai/artifact/8Ws41qUugWrYiNkkC6DGT5).

**Status:** milestone 2 of 5 (local-folder tracker). It reads local checkouts only; GitHub and GitLab come in milestones 3 and 4. Checked against AI-DLC 2.11.3.

## Run the tracker

Requires Node 22.5 or later. No npm dependencies.

```bash
npm run dev      # http://127.0.0.1:3100, tracking the sample repo, restarts on file changes
npm start        # same server without the sample repo; add folders on the Connections screen
npm test
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3100` | Port |
| `HOST` | `127.0.0.1` | Address to listen on |
| `DATABASE_PATH` | `./data/tracker.db` | SQLite file |
| `LOCAL_REPOS` | none | Folders to track on start, separated by `:` (`;` on Windows) |
| `POLL_SECONDS` | `30` | How often local folders are read again; `0` turns it off |
| `ALLOW_LOCAL_REPOS` | `1` on loopback, else `0` | Whether the Connections screen may add local folders |

Screens: **Inbox** (everything waiting on a person, oldest first, filtered by who answers, phase, repo and age), **Work** (one row per piece of work, sorted by most blocked), a page per piece of work (lifecycle spine, open and answered questions, approvals, agent notes, timeline, file problems), and **Connections**.

The server reads a folder only when it is bound to loopback, unless `ALLOW_LOCAL_REPOS=1`. Write requests must be JSON, so another website cannot make a browser post to it.

## API

| Route | Returns |
| --- | --- |
| `GET /api/health` | Status, counts, last sync, parser version |
| `GET /api/repos` | Tracked repos with branch, counts, last read, error |
| `POST /api/repos` `{path}` | Adds a local folder and reads it |
| `DELETE /api/repos/:id` | Stops tracking; deletes its rows |
| `POST /api/repos/:id/resync` | Reads it again now |
| `GET /api/intents?sort=blocked\|activity\|progress&repo=&phase=&stale=1` | Pieces of work |
| `GET /api/intents/:id` | One piece of work with questions, events, approvals |
| `GET /api/questions?open=true&trade=&phase=&repo=&type=questions\|approvals&olderThanDays=` | The inbox |

## Command line

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
server.mjs                starts the app (src/app.mjs) from environment variables
src/app.mjs               HTTP server, JSON API, static files
src/db.mjs                SQLite schema (node:sqlite)
src/sync.mjs              sync jobs: read, skip if unchanged, replace a branch's rows; keeps first-seen and answered times
public/                   the screens: vanilla ES modules, no build step
bin/aidlc-tracker.mjs     command-line tool
src/parse/                one parser per file type, plus repo.mjs that builds a snapshot per intent
src/parse/events.mjs      the 134 audit events, generated from the AI-DLC docs
src/source/local.mjs      reads a local checkout into the path -> text Map the parser takes
src/inbox.mjs             inbox and portfolio views across repos
fixtures/                 upstream AI-DLC samples and a sample repo (see fixtures/README.md)
test/                     node:test suite
```

A file the parser cannot fully read never stops a sync: it shows as a warning on that piece of work.
