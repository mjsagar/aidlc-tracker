// Parses an AI-DLC `<stage>-questions.md` file.
//
// Format (core/aidlc-common/protocols/stage-protocol.md, AI-DLC 2.11.3):
//   ## Q<n>. [<trade>] <title>      trade is optional; older files have none
//   prompt lines, lettered options ("A. ...", "- A. ..."), then one `[Answer]:` line.
//   ## Consolidated Summary Confirmation   options "- Looks correct" / "- Request changes"
// An answer is blank when the rest of its line is only spaces, tabs or underscores
// (the engine's own test: /\[Answer\]:[ \t]*_*[ \t]*$/m).

const HEADING = /^ {0,3}##(?:[ \t]+|$)(.*)$/;
const QUESTION_TITLE = /^Q(\d+)\.?\s*(?:\[([^\]]+)\]\s*)?(.*)$/;
const ANSWER = /^(?:﻿)?\s*\[Answer\]:[ \t]*(.*)$/;
const OPTION = /^\s*(?:[-*]\s+)?([A-Z])\.\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const SUMMARY = /summary confirmation/i;
const MULTI_SELECT = /\(select all that apply\)/i;

/** True when an `[Answer]:` value holds an answer, by the engine's rule. */
export function isAnswered(value) {
  return /[^\s_]/.test(value ?? "");
}

/**
 * @param {string} text  file contents
 * @param {string} [file] path, used in warnings
 * @returns {{questions: Question[], warnings: {file?: string, line?: number, message: string}[]}}
 */
export function parseQuestions(text, file) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let current = null;
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h && !line.startsWith("###")) {
      current = { heading: h[1].trim(), line: i + 1, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push({ text: line, line: i + 1 });
    }
  });

  const questions = [];
  const warnings = [];
  const warn = (message, line) => warnings.push({ file, line, message });

  for (const section of sections) {
    const summary = SUMMARY.test(section.heading);
    const q = summary ? null : QUESTION_TITLE.exec(section.heading);
    const answers = section.body.filter((l) => ANSWER.test(l.text));
    if (!summary && !q && answers.length === 0) continue; // Sources and other notes

    const options = [];
    const prompt = [];
    for (const l of section.body) {
      if (ANSWER.test(l.text)) continue;
      const opt = OPTION.exec(l.text);
      if (opt) { options.push({ key: opt[1], text: opt[2].trim() }); continue; }
      const bullet = summary ? BULLET.exec(l.text) : null;
      if (bullet) { options.push({ key: null, text: bullet[1].trim() }); continue; }
      if (l.text.trim() && !l.text.trim().startsWith("<!--")) prompt.push(l.text.trim());
    }

    let answer = null;
    let answerLine = null;
    if (answers.length === 0) {
      warn(`Question "${section.heading}" has no [Answer]: line; counted as open`, section.line);
    } else {
      answer = ANSWER.exec(answers[0].text)[1].trimEnd();
      answerLine = answers[0].line;
      if (answers.length > 1) warn(`Question "${section.heading}" has ${answers.length} [Answer]: lines; using the first`, answers[1].line);
    }
    if (!summary && !q) warn(`Section "${section.heading}" holds an [Answer]: line but is not a numbered question`, section.line);

    const open = !isAnswered(answer);
    const title = summary ? section.heading : q ? q[3].trim() : section.heading;
    questions.push({
      kind: summary ? "summary" : "question",
      number: q ? Number(q[1]) : null,
      trade: q && q[2] ? q[2].trim() : null,
      title,
      prompt: prompt.join("\n"),
      options,
      multiSelect: MULTI_SELECT.test(title) || MULTI_SELECT.test(prompt.join(" ")),
      answer: open ? null : answer.trim(),
      open,
      line: section.line,
      answerLine,
    });
  }
  return { questions, warnings };
}

/** @typedef {{kind: "question"|"summary", number: number|null, trade: string|null, title: string, prompt: string,
 *   options: {key: string|null, text: string}[], multiSelect: boolean, answer: string|null, open: boolean,
 *   line: number, answerLine: number|null}} Question */
