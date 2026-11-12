// Parses AI-DLC audit shards: `<record>/audit/<host>-<clone>.md`, one file per clone.
//
// core/knowledge/aidlc-shared/audit-format.md (AI-DLC 2.11.3): readers split on `---`
// and use the FIRST timestamp in each block; values have line terminators escaped.
//
//   ## <Title>
//   **Timestamp**: 2026-10-13T10:27:19Z
//   **Event**: STAGE_STARTED
//   **<Field>**: <value>

import { KNOWN_EVENTS } from "./events.mjs";

const SEPARATOR = /^---\s*$/;
const TITLE = /^##[ \t]+(.+?)\s*$/;
const FIELD = /^\*\*(.+?)\*\*:[ \t]?(.*)$/;

const unescape = (v) => v.replace(/\\r\\n|\\n|\\r/g, "\n");

/**
 * @param {string} text
 * @param {string} shard  shard file name, kept on each event
 */
export function parseAuditShard(text, shard) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [[]];
  lines.forEach((line, i) => {
    if (SEPARATOR.test(line)) blocks.push([]);
    else blocks.at(-1).push({ text: line, line: i + 1 });
  });

  const events = [];
  const warnings = [];
  blocks.forEach((block, index) => {
    let title = null;
    const fields = {};
    for (const { text: line } of block) {
      const t = TITLE.exec(line);
      if (t && title === null) { title = t[1]; continue; }
      const f = FIELD.exec(line);
      if (f) {
        const key = f[1].trim();
        if (!(key in fields)) fields[key] = unescape(f[2].trim()); // first wins (Timestamp rule)
      }
    }
    if (!fields.Event) return; // file header, notes without an event
    const firstLine = block.find((l) => l.text.trim())?.line ?? null;
    const at = Date.parse(fields.Timestamp ?? "");
    if (Number.isNaN(at)) warnings.push({ file: shard, line: firstLine, message: `Event ${fields.Event} has no valid Timestamp` });
    const { Timestamp, Event, ...rest } = fields;
    events.push({
      timestamp: Timestamp ?? null,
      at: Number.isNaN(at) ? null : at,
      event: Event,
      known: KNOWN_EVENTS.has(Event),
      title,
      stage: rest.Stage ?? null,
      unit: rest.Unit ?? null,
      gitName: rest["Git Name"] ?? null,
      fields: rest,
      shard,
      index,
      line: firstLine,
    });
  });
  return { events, warnings };
}

/**
 * Merges shards into one timeline, oldest first. Events with no timestamp go last.
 * Ties keep shard name order, then position; ties across shards are marked `unordered`.
 * @param {{name: string, text: string}[]} shards
 */
export function mergeAudit(shards) {
  const warnings = [];
  const all = [];
  for (const { name, text } of [...shards].sort((a, b) => a.name.localeCompare(b.name))) {
    const parsed = parseAuditShard(text, name);
    all.push(...parsed.events);
    warnings.push(...parsed.warnings);
  }
  all.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.shard.localeCompare(b.shard) || a.index - b.index);
  for (let i = 0; i < all.length; i++) {
    const tie = (j) => j >= 0 && j < all.length && all[j].at !== null && all[j].at === all[i].at && all[j].shard !== all[i].shard;
    all[i].unordered = tie(i - 1) || tie(i + 1);
  }
  return { events: all, warnings };
}
