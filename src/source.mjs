// Source files and mistakes (docs/spec.md §16). Every phase of the compiler reports into one Diagnostics
// list; each mistake has its code (§16.4), the file, line and column where it stands (§16.2.1), a message in plain
// words, and labels on related code, and is printed with its source line and the construct underlined:
//
//   irs-2848.stride:42:17: mistake S318: the record representative has no field nmae; did you mean name?
//     42 |   fill "Name" = r.nmae
//        |                 ^^^^^^ no field nmae
//     12 | record representative {
//        |        -------------- representative is declared here
//     stride explain S318

// One source file: its name (as it is shown in mistakes), its text, and where each line starts. `\r\n` and a lone
// `\r` end a line as `\n` does (§1.2): the text is kept with every line end made `\n`.
// Where bytes stop being UTF-8 (§1.1): the offset of the first byte that neither starts nor continues a character
// (an overlong form, a surrogate or a value above U+10FFFF is not one), or -1 when every byte is.
export function invalidUtf8(b) {
  for (let i = 0; i < b.length; ) {
    const x = b[i];
    const [n, min] = x < 0x80 ? [0, 0] : x >= 0xc2 && x <= 0xdf ? [1, 0x80] : x >= 0xe0 && x <= 0xef ? [2, 0x800] : x >= 0xf0 && x <= 0xf4 ? [3, 0x10000] : [-1, 0];
    if (n < 0) return i;
    let cp = n ? x & (0x3f >> n) : x;
    for (let k = 1; k <= n; k++) {
      if (i + k >= b.length || (b[i + k] & 0xc0) !== 0x80) return i;
      cp = cp * 64 + (b[i + k] & 0x3f);
    }
    if (cp < min || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return i;
    i += n + 1;
  }
  return -1;
}

// A file as the compiler reads it: its text (from its bytes, which must be UTF-8, or from text already decoded),
// line ends made \n. Bytes that are not UTF-8 leave `invalid` at the first one, { line, col } (§1.1), and the text
// decoded up to it, for showing.
export class SourceFile {
  constructor(name, source) {
    this.name = name;
    this.invalid = null;
    let text = source;
    if (typeof source !== "string") {
      const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
      const bad = invalidUtf8(bytes);
      // A byte-order mark is kept as the character it is: S001 at 1:1, as anywhere else (§2.7).
      text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bad < 0 ? bytes : bytes.subarray(0, bad));
      if (bad >= 0) {
        const before = text.replace(/\r\n?/g, "\n").split("\n");
        this.invalid = { line: before.length, col: [...before[before.length - 1]].length + 1 };
      }
    }
    this.text = text.replace(/\r\n?/g, "\n");
    this.lineStarts = [0];
    for (let i = 0; i < this.text.length; i++) if (this.text[i] === "\n") this.lineStarts.push(i + 1);
  }

  // The text of line n (from 1), without its line break.
  line(n) {
    const start = this.lineStarts[n - 1];
    if (start === undefined) return "";
    const end = this.lineStarts[n] ?? this.text.length + 1;
    return this.text.slice(start, end - 1);
  }

  get lineCount() {
    return this.lineStarts.length;
  }
}

// The kinds of mistake, so a tool (or a test) can tell them apart without reading the message.
export const KIND = {
  SYNTAX: "syntax",
  LIBRARY: "library",
  NAME: "name",
  TYPE: "type",
  FLOW: "flow",
  PDF: "pdf",
  LIMIT: "limit",
};

export class Diagnostic {
  constructor(kind, file, span, message, notes = [], severity = "error", code = null) {
    this.severity = severity; // error: the program cannot run; warning: it can, but likely not as meant
    this.kind = kind;
    this.code = code; // S001…, W001… (§16.4)
    this.file = file; // a SourceFile, or null for mistakes about the whole program (the header, the PDF)
    this.span = span ?? null;
    this.message = message;
    this.notes = notes ?? []; // labels on related code: [{ file, span, message }]
    this.label = null; // the words beside the place's marks; the message's first clause when not given
  }

  // What the first label, the place's, says (§16.2): its own words, or the message up to its first ";".
  get placeLabel() {
    return this.label ?? this.message.split(";")[0];
  }

  get line() {
    return this.span?.line ?? 0;
  }

  get column() {
    return this.span?.col ?? 0;
  }

  // The mistake printed for a person (§16.2): where, the code, what; the construct underlined; each label with
  // its own source line; then how to read more.
  format({ color = false } = {}) {
    const warning = this.severity === "warning";
    const red = (t) => (color ? `\x1b[${warning ? 33 : 31}m${t}\x1b[0m` : t);
    const dim = (t) => (color ? `\x1b[2m${t}\x1b[0m` : t);
    const out = [`${place(this.file, this.span)}: ${warning ? "warning" : "error"}${this.code ? ` ${this.code}` : ""}: ${red(this.message)}`];
    if (this.file && this.span) out.push(...excerpt(this.file, this.span, dim, "^", this.placeLabel));
    for (const n of this.notes) {
      if (n.file && n.span) out.push(...excerpt(n.file, n.span, dim, "-", n.message, n.file !== this.file));
      else out.push(`  ${n.message}`);
    }
    if (this.code) out.push(`  stride explain ${this.code}`);
    return out.join("\n");
  }

  // One JSON object for an editor (§16.2); ends are exclusive.
  toJSON() {
    const pos = (file, span) => ({
      file: file?.name ?? null,
      line: span?.line ?? 0,
      column: span?.col ?? 0,
      endLine: span?.endLine ?? span?.line ?? 0,
      endColumn: span?.endCol ?? span?.col ?? 0,
    });
    return {
      code: this.code,
      severity: this.severity,
      ...pos(this.file, this.span),
      message: this.message,
      // The first label is the place (§16.2.1), then the related code.
      labels: [...(this.span ? [{ ...pos(this.file, this.span), message: this.placeLabel }] : []), ...this.notes.map((n) => ({ ...pos(n.file, n.span), message: n.message }))],
    };
  }
}

function place(file, span) {
  const name = file?.name ?? "the program";
  return span ? `${name}:${span.line}:${span.col}` : name;
}

// The source line with the span marked (to the end of the line when it runs on), counting columns as code points
// (§1.3); a label's message follows its marks.
function excerpt(file, span, dim, mark, label, withName = false) {
  const chars = [...file.line(span.line)];
  const width = String(span.line).length;
  const gutter = " ".repeat(width);
  const from = Math.max(0, span.col - 1);
  const to = span.endLine === span.line ? Math.max(from + 1, span.endCol - 1) : Math.max(from + 1, chars.length);
  const show = (cs) => cs.map((c) => (c === "\t" ? "  " : c)).join("");
  const lead = show(chars.slice(0, from)).replace(/[^\s]/g, " ");
  const marks = mark.repeat(Math.max(1, show(chars.slice(from, to)).length));
  const head = withName ? [dim(`  ${file.name}:${span.line}:${span.col}`)] : [];
  return [...head, dim(`  ${String(span.line).padStart(width)} | `) + show(chars), dim(`  ${gutter} | `) + lead + marks + (label ? ` ${label}` : "")];
}

// The list every phase adds to. A phase that cannot go on without what an earlier one gave stops when the
// list has mistakes (the driver decides); a phase reports every mistake it finds, not only the first.
export class Diagnostics {
  constructor() {
    this.list = [];
  }

  // A mistake with its code (§16.4).
  add(kind, file, span, message, notes, code = null) {
    const d = new Diagnostic(kind, file, span, message, notes, "error", code);
    this.list.push(d);
    return d;
  }

  warn(kind, file, span, message, notes, code = null) {
    const d = new Diagnostic(kind, file, span, message, notes, "warning", code);
    this.list.push(d);
    return d;
  }

  // Mistakes, not warnings.
  get count() {
    return this.list.filter((d) => d.severity === "error").length;
  }

  get warnings() {
    return this.list.filter((d) => d.severity === "warning");
  }

  // No mistakes (warnings may be there).
  get empty() {
    return this.count === 0;
  }

  // In the order of the files, then of their lines and columns; the same mistake at the same place once.
  sorted() {
    const seen = new Set();
    const out = [];
    for (const d of this.list) {
      const key = `${d.file?.name}\t${d.line}\t${d.column}\t${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out.sort((a, b) => (a.file?.name ?? "").localeCompare(b.file?.name ?? "") || a.line - b.line || a.column - b.column);
  }
}

// The span of a name where a construct declares it (§16.2.1: the smallest construct): its first whole-word
// occurrence on the construct's first line, from where the construct starts; the construct's own span when the
// name is not found there.
export function nameSpan(file, span, name) {
  if (!file || !span) return span;
  const chars = [...file.line(span.line)];
  const text = chars.join("");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
  const from = chars.slice(0, span.col - 1).join("").length;
  const m = re.exec(text.slice(from));
  if (!m) return span;
  const col = [...text.slice(0, from + m.index)].length + 1;
  return { ...span, col, endLine: span.line, endCol: col + [...name].length, start: undefined, end: undefined };
}

// The name nearest to one that was not found, if one is near enough to be a slip of the keyboard (§12.5): compared
// with case and `_` ignored, and at most a third of the letters of the longer of the two different.
export function nearest(name, candidates) {
  const fold = (x) => x.toLowerCase().replaceAll("_", "");
  const wanted = fold(name);
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    if (c === name) continue;
    const other = fold(c);
    const d = distance(wanted, other);
    if (d * 3 <= Math.max(wanted.length, other.length) && d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

// Damerau-Levenshtein distance (with adjacent transpositions): how many single-character edits turn a into b.
export function distance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// "did you mean …?" for a message, or nothing.
export function didYouMean(name, candidates) {
  const n = nearest(name, candidates);
  return n ? `; did you mean ${n}?` : "";
}

// A list of words for a message: "a", "a or b", "a, b or c".
export function either(words, last = "or") {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

// One thing or several: plural(1, "box") is "1 box", plural(2, "box", "boxes") is "2 boxes".
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// A fault as §16.3 shows it: the machine's, shared with the browser page.
export { faultWords } from "../runtime/vm.mjs";
