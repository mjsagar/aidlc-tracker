# AI-DLC Tracker

Tracks AI-DLC work across repos: unanswered questions, stages waiting for approval, and progress through the phases. It reads the records AI-DLC commits under `aidlc/spaces/` and never writes to a repo.

Design: [AI-DLC Tracker: design](https://claude.ai/artifact/8Ws41qUugWrYiNkkC6DGT5).

**Status:** milestone 3 of 5 (GitHub). Reads local checkouts and GitHub repos; GitLab comes in milestone 4. Checked against AI-DLC 2.11.3.

## Run the tracker

Requires Node 22.5 or later. No npm dependencies.

```bash
npm run dev      # http://127.0.0.1:3100, tracking the sample repo, restarts on file changes
npm start        # same server without the sample repo; add folders on the Connections screen
npm test
node --disable-warning=ExperimentalWarning scripts/demo-github.mjs   # http://127.0.0.1:3101 against a fake GitHub
```

## Connect GitHub

1. Start the tracker and open **Connections**. Click **Set up GitHub** (fill in an organisation if the repos belong to one).
2. GitHub shows a private app that can only read repo contents. Create it. The tracker receives the app's keys and stores them encrypted.
3. GitHub asks which repos the app may read. Choose them; the tracker reads each repo's default branch.
4. Sign in with GitHub. From then on everyone signs in, and each person sees only the repos their GitHub account can read (re-checked hourly).

Set-up is allowed only from the computer running the tracker, or with `SETUP_TOKEN` sent as `X-Setup-Token`.

While the tracker runs on `localhost`, GitHub cannot deliver webhooks, so tracked branches are checked every 30 seconds with conditional requests; a check that finds nothing new returns 304 and does not count against GitHub's rate limit. When `PUBLIC_URL` is a public address, the app is created with a push webhook as well. Every 6 hours the tracker re-lists the app's installations to catch anything missed.

Per repo you can track more branches on the Connections screen. Only files under `aidlc/` and `.aidlc-version` are downloaded, and a file is downloaded again only when its content changes.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3100` | Port |
| `HOST` | `127.0.0.1` | Address to listen on |
| `DATABASE_PATH` | `./data/tracker.db` | SQLite file |
| `LOCAL_REPOS` | none | Folders to track on start, separated by `:` (`;` on Windows) |
| `POLL_SECONDS` | `30` | How often local folders are read again; `0` turns it off |
| `ALLOW_LOCAL_REPOS` | `1` on loopback, else `0` | Whether the Connections screen may add local folders |
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | Address people and GitHub use; webhooks are switched on when it is not localhost |
| `GITHUB_POLL_SECONDS` | `30` | How often tracked GitHub branches are checked; `0` turns it off |
| `TRACKER_SECRET_KEY` | generated into `secret.key` beside the database | 32 bytes, base64; encrypts stored GitHub credentials and sign-in tokens |
| `SETUP_TOKEN` | none | Allows GitHub set-up from another computer |

Screens: **Inbox** (everything waiting on a person, oldest first, filtered by who answers, phase, repo and age), **Work** (one row per piece of work, sorted by most blocked), a page per piece of work (lifecycle spine, open and answered questions, approvals, agent notes, timeline, file problems), and **Connections**.

The server reads a folder only when it is bound to loopback, unless `ALLOW_LOCAL_REPOS=1`. Write requests must be JSON, so another website cannot make a browser post to it.

## API

| Route | Returns |
| --- | --- |
| `GET /api/health` | Status, counts, last sync, parser version, GitHub rate limit left (no sign-in needed) |
| `GET /api/me` | Who is signed in, whether sign-in is required, GitHub set-up state |
| `GET /api/repos` | Tracked repos with their branches, counts, last read, errors |
| `POST /api/repos/:id/branches` `{name}`, `DELETE /api/repos/:id/branches/:branchId` | Track or stop tracking a branch (GitHub repos) |
| `POST /api/github/manifest` `{org?}` | Starts GitHub set-up; returns the form GitHub expects |
| `POST /api/github/reconcile` | Re-lists the app's installations and repos now |
| `POST /api/webhooks/github` | GitHub webhooks (signature checked, repeats ignored) |
| `GET /auth/github/login`, `POST /api/auth/signout` | Sign in and out |
| `POST /api/repos` `{path}` | Adds a local folder and reads it |
| `DELETE /api/repos/:id` | Stops tracking a local folder; deletes its rows |
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
src/sync.mjs              sync jobs: read, skip if unchanged, replace a branch's rows; installation backfill; retries after rate limits
src/github/               GitHub App client (JWT, installation tokens, ETags, pagination) and webhook handler
src/source/github.mjs     reads a branch's aidlc/ folder through the API, fetching only changed files
src/auth.mjs              sign-in with GitHub, sessions, per-person repo visibility
src/secrets.mjs           AES-256-GCM for stored credentials; webhook signature checks
test/fake-github.mjs      a stand-in for the GitHub API used by the tests and the demo
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
