# AI-DLC Tracker

Tracks AI-DLC work across repos: unanswered questions, stages waiting for approval, and progress through the phases. It reads the records AI-DLC commits under `aidlc/spaces/` and never writes to a repo.

Design: [AI-DLC Tracker: design](https://claude.ai/artifact/8Ws41qUugWrYiNkkC6DGT5).

**Status:** milestone 5 of 5 (deploy). Reads local checkouts, GitHub repos and gitlab.com projects; runs on Railway. Checked against AI-DLC 2.11.3.

## Run the tracker

Requires Node 22.5 or later. No npm dependencies.

```bash
npm run dev      # http://127.0.0.1:3100, tracking the sample repo, restarts on file changes
npm start        # same server without the sample repo; add folders on the Connections screen
npm test
node --disable-warning=ExperimentalWarning scripts/demo.mjs   # http://127.0.0.1:3101 against a fake GitHub and GitLab
```

## Connect GitHub

1. Start the tracker and open **Connections**. Click **Set up GitHub** (fill in an organisation if the repos belong to one).
2. GitHub shows a private app that can only read repo contents. Create it. The tracker receives the app's keys and stores them encrypted.
3. GitHub asks which repos the app may read. Choose them; the tracker reads each repo's default branch.
4. Sign in with GitHub. From then on everyone signs in, and each person sees only the repos their GitHub account can read (re-checked hourly).

Set-up is allowed only from the computer running the tracker, or with `SETUP_TOKEN` sent as `X-Setup-Token`.

While the tracker runs on `localhost`, GitHub cannot deliver webhooks, so tracked branches are checked every 30 seconds with conditional requests; a check that finds nothing new returns 304 and does not count against GitHub's rate limit. When `PUBLIC_URL` is a public address, the app is created with a push webhook as well. Every 6 hours the tracker re-lists the app's installations to catch anything missed.

## Connect GitLab (gitlab.com)

GitLab has no one-click app set-up, so it takes two things you create on gitlab.com:

1. An **OAuth application** (your avatar, Edit profile, Applications; or a group's Settings, Applications) with the redirect URI the Connections screen shows, Confidential ticked, and only the `read_api` scope. People sign in with it.
2. An **access token** with only `read_api`. A group access token is best, so reading does not depend on one person; a personal access token works too. The tracker reads projects with it and warns 14 days before it expires; replace it on the Connections screen.

Paste both on the Connections screen (from the computer running the tracker), sign in with GitLab, and add projects by path or URL. You can add only projects your own GitLab account can read, and each person sees only the projects their GitLab account can read. One session can be signed in to GitHub and GitLab at once.

Tracked branches are checked every 30 seconds. Registering a webhook needs write access, so the tracker does not do it: when `PUBLIC_URL` is public, Connections shows a webhook URL and secret token for a Maintainer to add to each project (Push events). Every 6 hours the tracker re-reads each project's name and default branch; a project the token can no longer read is flagged, not deleted.

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
| `GITHUB_POLL_SECONDS` | `30`, or `300` when webhooks are on | How often tracked GitHub branches are checked; `0` turns it off |
| `GITLAB_POLL_SECONDS` | `30` | How often tracked GitLab branches are checked; `0` turns it off |
| `TRACKER_SECRET_KEY` | generated into `secret.key` beside the database | 32 bytes, base64; encrypts stored GitHub credentials and sign-in tokens |
| `SETUP_TOKEN` | none | Allows GitHub and GitLab set-up from another computer (entered on the Connections screen). When the server listens beyond loopback, this is the only way |

Screens: **Inbox** (everything waiting on a person, oldest first, filtered by who answers, phase, repo and age), **Work** (one row per piece of work, sorted by most blocked), a page per piece of work (lifecycle spine, open and answered questions, approvals, agent notes, timeline, file problems), and **Connections**.

The server reads a folder only when it is bound to loopback, unless `ALLOW_LOCAL_REPOS=1`. Write requests must be JSON, so another website cannot make a browser post to it.

## Deploy (Railway)

The repo builds with its `Dockerfile` (no npm install; the image holds only `server.mjs`, `src/`, `public/` and `bin/`). The container runs as the `node` user, listens on `0.0.0.0:3100`, and keeps the database in `/app/data`.

```bash
railway login
railway init --name aidlc-tracker
railway up --detach                                   # first build; creates the service
railway volume add --mount-path /app/data             # the database must survive redeploys
railway domain                                        # prints https://<name>.up.railway.app
railway variables --set "PUBLIC_URL=https://<name>.up.railway.app" \
  --set "SETUP_TOKEN=$(openssl rand -base64 24)" \
  --set "TRACKER_SECRET_KEY=$(openssl rand -base64 32)" \
  --set "RAILWAY_RUN_UID=0"
railway up --detach                                   # redeploy with the settings
BASE_URL=https://<name>.up.railway.app npm run smoke
```

- `RAILWAY_RUN_UID=0` is needed because Railway mounts volumes as root and the image runs as `node`.
- Keep `TRACKER_SECRET_KEY` somewhere safe (a password manager). Stored GitHub and GitLab credentials and sign-in tokens are encrypted with it; without it, a copy of the database is useless, and so is the database itself if the key is lost.
- `SETUP_TOKEN` is asked for on the Connections screen the first time you set up GitHub or GitLab on the deployed tracker. Remove the variable afterwards if you like.
- Set up a **new** GitHub App from the deployed tracker. Its manifest then carries the public callback URLs and a push webhook. An app created on `localhost` has neither.
- For GitLab, add a second OAuth application (or edit the redirect URI) with `https://<name>.up.railway.app/auth/gitlab/callback`.
- Once webhooks are on, GitHub branches are polled only every 5 minutes as a backstop. `/api/health` reports, for the last 7 days, how many changes arrived by webhook and how many polling found first (a webhook that never came). `npm run smoke` prints both.
- Run a single replica: the job queue and polling live in one process.

## API

| Route | Returns |
| --- | --- |
| `GET /api/health` | Status, counts, last sync, parser version, GitHub rate limit left, changes by webhook and by polling over 7 days (no sign-in needed) |
| `GET /api/me` | Who is signed in, whether sign-in is required, GitHub set-up state |
| `GET /api/repos` | Tracked repos with their branches, counts, last read, errors |
| `POST /api/repos/:id/branches` `{name}`, `DELETE /api/repos/:id/branches/:branchId` | Track or stop tracking a branch (GitHub repos) |
| `POST /api/github/manifest` `{org?}` | Starts GitHub set-up; returns the form GitHub expects |
| `POST /api/github/reconcile` | Re-lists the app's installations and repos now |
| `POST /api/webhooks/github` | GitHub webhooks (signature checked, repeats ignored) |
| `POST /api/gitlab/setup` `{clientId, clientSecret, token}` | Connects GitLab (from this computer or with the setup token) |
| `PUT /api/gitlab/token` `{token}` | Replaces the GitLab access token |
| `GET /api/gitlab/projects?search=`, `POST /api/gitlab/projects` `{path}` | Projects you can add; track one |
| `POST /api/webhooks/gitlab` | GitLab webhooks (secret token checked, repeats ignored) |
| `GET /auth/gitlab/login` | Sign in with GitLab (OAuth with PKCE) |
| `GET /auth/github/login`, `POST /api/auth/signout` | Sign in and out |
| `POST /api/repos` `{path}` | Adds a local folder and reads it |
| `DELETE /api/repos/:id` | Stops tracking a local folder or GitLab project; deletes its rows |
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
src/gitlab/               GitLab client (read_api token, OAuth with PKCE and refresh) and webhook handler
src/source/github.mjs     reads a branch's aidlc/ folder through the GitHub API, fetching only changed files
src/source/gitlab.mjs     the same for GitLab
src/auth.mjs              sign-in with GitHub and GitLab, sessions, per-person repo visibility
src/secrets.mjs           AES-256-GCM for stored credentials; webhook signature checks
test/fake-github.mjs      stand-ins for the GitHub and GitLab APIs used by the tests and the demo
test/fake-gitlab.mjs
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
