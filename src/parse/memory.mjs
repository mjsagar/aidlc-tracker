// Parses the "Open questions" section of a stage's `memory.md`
// (core/knowledge/aidlc-shared/memory-template.md, AI-DLC 2.11.3).
// Entries are bullets "- <timestamp> — <text>"; the template's examples are HTML comments.

const ENTRY = /^\s*[-*]\s+(?:(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s*[—–-]+\s*)?(.+)$/;

export function parseMemoryOpenQuestions(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const out = [];
  let inSection = false;
  lines.forEach((line, i) => {
    if (/^##[ \t]+/.test(line)) { inSection = /^##[ \t]+open questions\s*$/i.test(line); return; }
    if (!inSection) return;
    const m = ENTRY.exec(line);
    if (m) out.push({ at: m[1] ?? null, text: m[2].trim(), line: i + 1 });
  });
  return out;
}
