// Phase 1: parse. The lexer and parser are written by hand (syntax.mjs); this module runs them and reports each
// mistake they found, where it stands, as a diagnostic. After a mistake the parser recovers at the next statement,
// so one run reports up to twenty.
import { KIND } from "./source.mjs";
import { parseSource } from "./syntax.mjs";

// The syntax tree of a program (start "Program") or a library ("Library"), or null after a mistake. Each node is
// marked with its file, so later phases can say where it came from.
export function parse(file, diagnostics, start = "Program") {
  if (file.invalid) {
    const { line, col } = file.invalid;
    diagnostics.add(KIND.SYNTAX, file, { line, col, endLine: line, endCol: col + 1, start: 0, end: 0 }, "the file is not UTF-8 text here: an ill-formed UTF-8 sequence starts at this byte", [], "S001");
    return null;
  }
  let result;
  try {
    result = parseSource(file.text, start, file.depth ?? 0);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    diagnostics.add(KIND.SYNTAX, file, null, "blocks, brackets and expressions nest more than 200 deep here; split it into functions or lets", [], "S019");
    return null;
  }
  for (const m of result.mistakes) diagnostics.add(KIND.SYNTAX, file, m.span, m.message, [], m.code ?? "S010");
  if (!result.tree) return null;
  mark(result.tree, file);
  return result.tree;
}

// Every node gets its file (not enumerable, so printing a tree stays readable).
function mark(value, file) {
  if (Array.isArray(value)) {
    for (const v of value) mark(v, file);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.kind) Object.defineProperty(value, "file", { value: file, enumerable: false, writable: true });
  for (const k of Object.keys(value)) if (k !== "span") mark(value[k], file);
}
