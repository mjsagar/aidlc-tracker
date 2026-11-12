// AI-DLC Tracker screens: inbox, work, one piece of work, connections.
// Everything read from repos is untrusted text: it is only ever inserted as text nodes.

import { el } from "./dom.js";

const main = document.getElementById("main");
const PHASES = ["Initialization", "Ideation", "Inception", "Construction", "Operation"];
const REFRESH_MS = 30_000;

// ---------- helpers

const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
};
const phaseKey = (p) => (p ?? "").toLowerCase();
const stageName = (s) => (s ? s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "Unknown stage");
const sentence = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// AI-DLC question text uses inline Markdown: `code` and **bold**. Rendered as real
// elements built from text nodes, never through innerHTML.
function rich(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text ?? ""); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? el("code", {}, m[1]) : el("strong", {}, m[2]));
    last = re.lastIndex;
  }
  if (last < (text ?? "").length) out.push(text.slice(last));
  return out;
}

function age(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return plural(mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 48) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day");
  return plural(Math.round(days / 30.4), "month");
}
const fullDate = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};
const timeEl = (iso, text) => el("time", { datetime: iso ?? "", title: fullDate(iso) }, text ?? (age(iso) ? `${age(iso)} ago` : "unknown"));

function toast(message) {
  const t = el("div", { class: "toast", role: "status" }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Path copied"); }
  catch { toast("Could not copy; select the path instead"); }
}

function select(label, name, options, value, onChange) {
  const s = el("select", { name, onchange: (e) => onChange(e.target.value) },
    ...options.map(([v, text]) => el("option", { value: v, selected: v === value }, text)));
  return el("label", { class: "field" }, label, s);
}

// Filters live in the hash query so a filtered view can be shared or reloaded.
function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query) };
}
function setParams(params) {
  const [path] = location.hash.replace(/^#/, "").split("?");
  const q = [...params].filter(([, v]) => v).length ? `?${new URLSearchParams([...params].filter(([, v]) => v))}` : "";
  location.hash = `${path || "/"}${q}`;
}

function setNav(name) {
  for (const a of document.querySelectorAll(".topnav a")) {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

async function updateCount() {
  try {
    const items = await api("/api/questions?open=true");
    const c = document.getElementById("inboxCount");
    c.textContent = String(items.length);
    c.hidden = items.length === 0;
    c.setAttribute("aria-label", `${items.length} waiting`);
  } catch { /* the page shows its own error */ }
}

function errorView(err) {
  main.replaceChildren(el("h1", {}, "Something went wrong"), el("p", { class: "lead" }, err.message),
    el("p", {}, el("a", { href: "#/" }, "Go to the inbox")));
}

// ---------- inbox

function itemKind(it) {
  if (it.type === "awaiting-approval") return el("span", { class: "kind attn" }, el("strong", {}, "Approval needed"));
  if (it.type === "revising") return el("span", { class: "kind attn" }, el("strong", {}, "Being revised"), it.revisionCount ? `, revision ${it.revisionCount}` : "");
  if (it.type === "summary") return el("span", { class: "kind" }, el("strong", {}, "Confirm the answer summary"));
  return el("span", { class: "kind" }, el("strong", {}, "Question"), it.trade ? ` for ${it.trade}` : ", no one named to answer");
}

async function inboxView({ params }) {
  setNav("inbox");
  const [items, repos] = await Promise.all([api("/api/questions?open=true"), api("/api/repos")]);
  const trade = params.get("trade") ?? "";
  const repo = params.get("repo") ?? "";
  const phase = params.get("phase") ?? "";
  const type = params.get("type") ?? "";
  const older = params.get("older") ?? "";

  const trades = [...new Set(items.map((i) => i.trade).filter(Boolean))].sort();
  const cutoff = Number(older) ? Date.now() - Number(older) * 864e5 : null;
  const shown = items.filter((i) =>
    (!trade || i.trade === trade) && (!repo || String(i.repo.id) === repo) && (!phase || phaseKey(i.phase) === phase) &&
    (!type || (type === "questions" ? ["question", "summary"].includes(i.type) : ["awaiting-approval", "revising"].includes(i.type))) &&
    (!cutoff || (i.since && Date.parse(i.since) < cutoff)));

  const update = (key) => (v) => { params.set(key, v); setParams(params); };
  const typeButton = (value, label) => el("button", { type: "button", "aria-pressed": String(type === value), onclick: () => update("type")(value) }, label);

  const filtered = shown.length !== items.length;
  const lead = items.length === 0
    ? "Nothing is waiting on anyone. New questions and approvals appear here after the next sync."
    : `${plural(items.length, "item")} waiting on a person${filtered ? `, ${shown.length} shown` : ""}. Oldest first.`;

  main.replaceChildren(
    el("h1", {}, "Inbox"),
    el("p", { class: "lead" }, lead),
    items.length === 0 ? (repos.length === 0 ? el("p", {}, el("a", { href: "#/connections" }, "Add a repo to track")) : "") : el("div", { class: "controls" },
      el("div", { class: "segmented", role: "group", "aria-label": "Show" }, typeButton("", "All"), typeButton("questions", "Questions"), typeButton("approvals", "Approvals")),
      select("Who answers", "trade", [["", "Anyone"], ...trades.map((t) => [t, t])], trade, update("trade")),
      select("Phase", "phase", [["", "All phases"], ...PHASES.map((p) => [phaseKey(p), p])], phase, update("phase")),
      repos.length > 1 ? select("Repo", "repo", [["", "All repos"], ...repos.map((r) => [String(r.id), r.name])], repo, update("repo")) : "",
      select("Waiting", "older", [["", "Any time"], ["1", "More than a day"], ["3", "More than 3 days"], ["7", "More than a week"], ["14", "More than 2 weeks"]], older, update("older")),
    ),
    items.length && !shown.length ? el("p", { class: "empty" }, "Nothing matches these filters.") : "",
    el("ul", { class: "inbox" }, ...shown.map((it) => {
      const title = it.type === "question" ? [`Q${it.number ?? "?"}. `, ...rich(it.title)]
        : [it.type === "summary" ? "Do the answers look correct?" : stageName(it.stage)];
      const a = age(it.since);
      return el("li", { class: "item", "data-phase": phaseKey(it.phase) },
        itemKind(it),
        el("div", { class: "age" }, a ? el("strong", {}, a) : el("strong", {}, "Unknown"), a ? timeEl(it.since, "waiting") : "since first sync"),
        el("h3", {}, ...title),
        el("div", { class: "context" },
          el("a", { href: `#/work/${it.intent}` }, it.description ?? it.key),
          it.type === "question" || it.type === "summary" ? el("span", {}, stageName(it.stage)) : el("span", {}, sentence(it.phase)),
          it.unit ? el("span", {}, `Unit ${it.unit}`) : "",
          repos.length > 1 ? el("span", {}, it.repo.name) : ""),
        el("div", { class: "path" },
          el("code", {}, `${it.file}${it.line ? `:${it.line}` : ""}`),
          el("button", { type: "button", class: "btn link small", onclick: () => copy(it.file) }, "Copy path")));
    })),
  );
}

// ---------- work

// Width set through the DOM: the Content-Security-Policy blocks inline style attributes.
function progressBar(done, total) {
  const pct = total ? (done / total) * 100 : 0;
  const fill = el("span");
  fill.style.width = `${pct}%`;
  return el("div", { class: "bar", role: "img", "aria-label": `${Math.round(pct)}% done` }, fill);
}

async function workView({ params }) {
  setNav("work");
  const sort = params.get("sort") ?? "blocked";
  const stale = params.get("stale") === "1";
  const repo = params.get("repo") ?? "";
  const q = new URLSearchParams({ sort, ...(stale ? { stale: "1" } : {}), ...(repo ? { repo } : {}) });
  const [rows, repos] = await Promise.all([api(`/api/intents?${q}`), api("/api/repos")]);
  const update = (key) => (v) => { params.set(key, v); setParams(params); };
  const repoCount = new Set(rows.map((r) => r.repo.id)).size;

  main.replaceChildren(
    el("h1", {}, "Work"),
    el("p", { class: "lead" }, rows.length
      ? `${plural(rows.length, "piece")} of AI-DLC work${stale ? " with no activity for 7 days" : ""} in ${plural(repoCount, "repo")}.`
      : stale ? "No work has been quiet for more than 7 days." : "No AI-DLC work found yet."),
    el("div", { class: "controls" },
      select("Sort by", "sort", [["blocked", "Most blocked"], ["activity", "Recent activity"], ["progress", "Least progress"]], sort, update("sort")),
      repos.length > 1 ? select("Repo", "repo", [["", "All repos"], ...repos.map((r) => [String(r.id), r.name])], repo, update("repo")) : "",
      el("label", { class: "check" }, el("input", { type: "checkbox", checked: stale, onchange: (e) => update("stale")(e.target.checked ? "1" : "") }), "Quiet for 7 days or more")),
    rows.length === 0 ? (repos.length === 0 ? el("p", {}, el("a", { href: "#/connections" }, "Add a repo to track")) : "") : el("table", { class: "table" },
      el("thead", {}, el("tr", {}, ...["Work", "Where it is", "Progress", "Waiting on a person", "Last activity"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, ...rows.map((r) => {
        const waitingText = [r.openQuestions ? plural(r.openQuestions, "question") : "", r.waiting ? plural(r.waiting, "approval") : ""].filter(Boolean).join(", ");
        return el("tr", { "data-phase": phaseKey(r.phase) },
          el("td", { class: "work-name" }, el("a", { href: `#/work/${r.id}` }, r.description ?? r.key),
            el("span", { class: "key mono muted small" }, repos.length > 1 ? `${r.repo.name} ${r.key}` : r.key),
            r.warnings ? el("span", { class: "warn-flag" }, plural(r.warnings, "file problem")) : ""),
          el("td", { class: "where", "data-label": "Where" }, el("span", { class: "phase-dot", "aria-hidden": "true" }), r.phase ? sentence(r.phase) : "Unknown",
            el("div", { class: "muted small" }, stageName(r.stage))),
          el("td", { "data-label": "Progress" }, `${r.done} of ${r.total} stages`,
            progressBar(r.done, r.total)),
          el("td", { class: `waiting${waitingText ? " attn" : ""}`, "data-label": "Waiting" }, waitingText || "Nothing",
            r.waitingSince ? el("div", { class: "muted small" }, age(r.waitingSince) ? `for ${age(r.waitingSince)}` : "for an unknown time") : ""),
          el("td", { "data-label": "Last activity" }, r.lastActivity ? timeEl(r.lastActivity) : "Unknown"));
      }))),
  );
}

// ---------- one piece of work

function spine(intent) {
  const byPhase = (p) => intent.stages.filter((s) => s.phase === p);
  const status = Object.fromEntries(intent.phases.map((p) => [p.name, p.status]));
  return el("div", {},
    el("div", { class: "spine" }, ...PHASES.map((p) => {
      const stages = byPhase(p);
      let lastUnit;
      return el("section", { class: `phase ${phaseKey(status[p] ?? "")}`, "data-phase": phaseKey(p), "aria-label": `${p} phase` },
        el("h3", {}, p),
        el("div", { class: "status" }, status[p] ?? "No status"),
        el("ul", { class: "stages" }, ...stages.flatMap((s) => {
          const out = [];
          if (s.unit && s.unit !== lastUnit) out.push(el("li", { class: "unit" }, `Unit ${s.unit}`));
          lastUnit = s.unit;
          const label = { "not-started": "not started", "in-progress": "in progress", "awaiting-approval": "waiting for approval", revising: "being revised", completed: "done", skipped: "skipped", unknown: "unknown" }[s.status];
          out.push(el("li", { class: s.planned === false ? "planned-no" : "", title: s.planned === false ? `Not in the plan${s.note ? `: ${s.note}` : ""}` : label },
            el("span", { class: `dot ${s.status}`, "aria-hidden": "true" }),
            el("span", {}, stageName(s.slug), el("span", { class: "sr-only" }, ` (${s.planned === false ? "not in the plan" : label})`))));
          return out;
        })));
    })),
    el("div", { class: "legend", "aria-hidden": "true" },
      el("span", {}, el("span", { class: "dot completed" }), "Done"),
      el("span", {}, el("span", { class: "dot in-progress" }), "In progress"),
      el("span", {}, el("span", { class: "dot awaiting-approval" }), "Waiting for a person"),
      el("span", {}, el("span", { class: "dot" }), "Not started"),
      el("span", {}, el("span", { class: "dot skipped" }), "Skipped")));
}

function questionItem(q) {
  const who = q.kind === "summary" ? "Summary confirmation" : q.trade ? `For ${q.trade}` : "No one named to answer";
  return el("li", { class: "q", "data-phase": phaseKey(q.phase) },
    el("div", { class: "q-head" },
      el("h3", {}, ...(q.kind === "summary" ? ["Do the answers look correct?"] : [`Q${q.number ?? "?"}. `, ...rich(q.title)])),
      el("span", { class: "who" }, who)),
    q.prompt ? el("p", { class: "prompt" }, ...rich(q.prompt)) : "",
    q.options.length ? el("ol", {}, ...q.options.map((o) => el("li", {}, o.key ? el("span", { class: "key" }, o.key) : "", ...rich(o.text)))) : "",
    q.open
      ? el("p", { class: "muted small" }, `${stageName(q.stage)}; open ${q.openSince ? `for ${age(q.openSince)}` : "since the first sync"}; `, el("code", {}, `${q.file}:${q.line}`))
      : el("p", { class: "answer" }, el("strong", {}, "Answer: "), ...rich(q.answer), q.answeredAt ? el("span", { class: "muted small" }, ` (${fullDate(q.answeredAt)})`) : ""));
}

async function intentView({ parts }) {
  setNav("work");
  const i = await api(`/api/intents/${encodeURIComponent(parts[1])}`);
  const open = i.questions.filter((q) => q.open);
  const answered = i.questions.filter((q) => !q.open);
  const eventsNewest = [...i.events].reverse();
  let showAll = false;

  const timelineList = el("ol", { class: "timeline" });
  const renderTimeline = () => {
    const list = showAll ? eventsNewest : eventsNewest.slice(0, 25);
    timelineList.replaceChildren(...list.map((e) => {
      const detail = e.fields.Details ?? e.fields["User Input"] ?? e.fields.File ?? e.fields.Agent ?? "";
      return el("li", {},
        e.timestamp ? timeEl(e.timestamp, fullDate(e.timestamp)) : el("time", {}, "No time"),
        el("div", {},
          el("span", { class: `ev${e.known ? "" : " unknown"}`, title: e.known ? "" : "Not an event this tracker knows; shown as recorded" }, e.event),
          e.stage ? ` ${stageName(e.stage)}` : "", e.gitName ? `, by ${e.gitName}` : "",
          detail ? el("span", { class: "detail small" }, detail) : ""));
    }));
  };
  renderTimeline();

  main.replaceChildren(
    el("a", { class: "back", href: "#/work" }, "All work"),
    el("h1", {}, i.description ?? i.key),
    el("dl", { class: "meta" },
      el("div", {}, el("dt", {}, "Repo"), el("dd", {}, i.repo.name)),
      el("div", {}, el("dt", {}, "Branch"), el("dd", {}, i.branch)),
      el("div", {}, el("dt", {}, "Folder"), el("dd", { class: "mono" }, i.key)),
      el("div", {}, el("dt", {}, "Scope"), el("dd", {}, i.scope ?? "Unknown")),
      el("div", {}, el("dt", {}, "Progress"), el("dd", {}, `${i.done} of ${i.total} stages`)),
      el("div", {}, el("dt", {}, "Last activity"), el("dd", {}, i.lastActivity ? timeEl(i.lastActivity) : "Unknown"))),
    spine(i),

    el("h2", {}, open.length || i.blockers.length ? "Waiting on a person" : "Nothing waiting"),
    ...i.blockers.map((b) => el("div", { class: "blocker" },
      el("h3", {}, b.type === "awaiting-approval" ? `${stageName(b.stage)} is waiting for approval` : `${stageName(b.stage)} is being revised${b.revisionCount ? ` (revision ${b.revisionCount})` : ""}`),
      el("p", {}, b.unit ? `Unit ${b.unit}. ` : "", b.since ? `Since ${fullDate(b.since)}${b.sinceSource === "state" ? " (from the state file; the audit trail has no time for it)" : ""}.` : "Start time unknown."))),
    open.length ? el("ul", { class: "qlist" }, ...open.map(questionItem)) : (!i.blockers.length ? el("p", { class: "muted" }, "No open questions and no stage waiting for approval.") : ""),

    answered.length ? el("details", {}, el("summary", {}, `${plural(answered.length, "answered question")}`), el("ul", { class: "qlist" }, ...answered.map(questionItem))) : "",

    i.approvals.length ? el("h2", {}, "Approvals") : "",
    i.approvals.length ? el("ul", { class: "notes" }, ...i.approvals.map((a) => el("li", {}, `${stageName(a.stage)}${a.unit ? `, unit ${a.unit}` : ""} approved by ${a.gitName ?? "someone (no git name recorded)"} on ${fullDate(a.at)}`))) : "",

    i.notes.length ? el("h2", {}, "Open questions in the agent's notes") : "",
    i.notes.length ? el("ul", { class: "notes" }, ...i.notes.map((n) => el("li", {}, n.text, el("span", { class: "muted small" }, ` (${stageName(n.stage)}${n.at ? `, ${fullDate(n.at)}` : ""})`)))) : "",

    el("h2", {}, "Timeline"),
    i.events.length ? timelineList : el("p", { class: "muted" }, "No audit trail in this folder."),
    i.events.length > 25 ? el("button", { type: "button", class: "btn", onclick: (e) => { showAll = !showAll; renderTimeline(); e.target.textContent = showAll ? "Show the latest 25" : `Show all ${i.events.length} events`; } }, `Show all ${i.events.length} events`) : "",

    i.warningList.length ? el("h2", {}, "Files the tracker could not fully read") : "",
    i.warningList.length ? el("ul", { class: "warnings" }, ...i.warningList.map((w) => el("li", {}, el("code", {}, `${w.file}${w.line ? `:${w.line}` : ""}`), ` ${w.message}`))) : "",

    el("p", { class: "muted small" }, `Read ${fullDate(i.syncedAt)}, parser ${i.parserVersion}.`),
  );
}

// ---------- connections

async function connectionsView() {
  setNav("connections");
  const [repos, health] = await Promise.all([api("/api/repos"), api("/api/health")]);
  const errorP = el("p", { class: "form-error", role: "alert", hidden: true });
  const input = el("input", { type: "text", name: "path", placeholder: "/Users/you/code/my-repo", autocomplete: "off", required: true, spellcheck: "false" });
  const addBtn = el("button", { type: "submit", class: "btn primary" }, "Add folder");

  const form = el("form", { class: "add-form", onsubmit: async (e) => {
    e.preventDefault();
    errorP.hidden = true;
    addBtn.disabled = true;
    addBtn.textContent = "Reading";
    try {
      const repo = await api("/api/repos", { method: "POST", body: JSON.stringify({ path: input.value }) });
      toast(`${repo.name}: ${plural(repo.intents, "piece")} of work found`);
      render();
    } catch (err) {
      errorP.textContent = err.message;
      errorP.hidden = false;
      addBtn.disabled = false;
      addBtn.textContent = "Add folder";
    }
  } }, el("label", { class: "field" }, "Folder of a repo checkout on this computer", input), addBtn);

  const resync = async (r, btn) => {
    btn.disabled = true;
    btn.textContent = "Reading";
    try { await api(`/api/repos/${r.id}/resync`, { method: "POST", body: "{}" }); toast(`${r.name} read again`); render(); }
    catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Read again"; }
  };
  const remove = async (r) => {
    if (!confirm(`Stop tracking ${r.name}? Its questions and history are removed from the tracker. The repo itself is not touched.`)) return;
    try { await api(`/api/repos/${r.id}`, { method: "DELETE" }); toast(`${r.name} removed`); render(); }
    catch (err) { toast(err.message); }
  };

  main.replaceChildren(
    el("h1", {}, "Connections"),
    el("p", { class: "lead" }, "Repos the tracker reads. It only reads the AI-DLC records under ", el("code", {}, "aidlc/"), " and never changes anything in a repo."),
    health.allowLocal ? form : el("p", { class: "muted" }, "Adding local folders is turned off on this server."),
    errorP,
    el("p", { class: "muted small" }, `Local folders are read again every 30 seconds. GitHub and GitLab connections are not available yet.`),
    el("h2", {}, repos.length ? plural(repos.length, "repo") : "No repos yet"),
    repos.length ? el("table", { class: "table" },
      el("thead", {}, el("tr", {}, ...["Repo", "Branch", "Work found", "AI-DLC", "Last read", ""].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, ...repos.map((r) => {
        const btn = el("button", { type: "button", class: "btn", onclick: () => resync(r, btn) }, "Read again");
        return el("tr", {},
          el("td", { class: "work-name" }, el("strong", {}, r.name), el("span", { class: "key mono muted small" }, r.path ?? r.webUrl ?? "")),
          el("td", { "data-label": "Branch" }, r.branch),
          el("td", { "data-label": "Work found" }, plural(r.intents, "piece"), r.openQuestions + r.waiting ? el("div", { class: "muted small" }, `${r.openQuestions + r.waiting} waiting`) : ""),
          el("td", { "data-label": "AI-DLC" }, r.aidlcVersion ?? "Not pinned"),
          el("td", { "data-label": "Last read" }, r.lastSyncedAt ? timeEl(r.lastSyncedAt) : "Not yet",
            r.syncError ? el("div", { class: "status-err small" }, r.syncError) : el("div", { class: "status-ok small" }, "OK")),
          el("td", {}, el("div", { class: "actions" }, btn, el("button", { type: "button", class: "btn danger", onclick: () => remove(r) }, "Remove"))));
      }))) : el("p", { class: "muted" }, "Add a folder above to start."),
  );
}

// ---------- router

let rendering = 0;
async function render() {
  const r = route();
  const ticket = ++rendering;
  try {
    if (r.parts[0] === "work" && r.parts[1]) await intentView(r);
    else if (r.parts[0] === "work") await workView(r);
    else if (r.parts[0] === "connections") await connectionsView(r);
    else await inboxView(r);
  } catch (err) {
    if (ticket === rendering) errorView(err);
  }
  updateCount();
}

let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  const pathChanged = location.hash.split("?")[0] !== lastHash.split("?")[0];
  lastHash = location.hash;
  render().then(() => { if (pathChanged) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); } });
});

// Refresh the lists while visible; not the detail or connections pages, where a re-render would lose open sections or typing.
setInterval(() => {
  if (document.hidden) return;
  const { parts } = route();
  if (!parts[0] || (parts[0] === "work" && !parts[1])) render(); else updateCount();
}, REFRESH_MS);

// Theme toggle
const themeBtn = document.getElementById("themeToggle");
const syncThemeLabel = () => themeBtn.setAttribute("aria-label", document.documentElement.dataset.theme === "light" ? "Switch to dark theme" : "Switch to light theme");
themeBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("aidlc-tracker:theme", next); } catch { /* not saved */ }
  syncThemeLabel();
});
syncThemeLabel();

render();
