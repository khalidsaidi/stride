// The standard library as `stride doc` shows it (§14): each function's signatures and what it gives, from the
// spec's tables (codes.mjs, generated from them), and its examples, from the `# example:` lines of lib/std.stride,
// which the conformance suite runs in every engine (tests/cli/library-examples.mjs).
import { LIBRARY } from "./codes.mjs";
import { stdSource } from "./compile.mjs";

// Each example of std.stride: { name, text, expr, verb, want }: `expr gives want` (what `stride eval` shows),
// `expr prints want`, or `expr faults F013`.
export function examples(std = stdSource()) {
  const out = [];
  let pending = [];
  for (const line of std.split("\n")) {
    const e = line.match(/^# example: (.*?) (gives|prints|faults) (.*)$/);
    if (e) pending.push({ text: `${e[1]} ${e[2]} ${e[3]}`, expr: e[1], verb: e[2], want: e[3] });
    const d = line.match(/^export (?:native )?define (\w+)(?:<[^>]*>)?\(/);
    if (d) {
      for (const x of pending) out.push({ name: d[1], ...x });
      pending = [];
    } else if (!e) pending = [];
  }
  return out;
}

// What the examples may use, as std.stride writes it: the lines between "may use these:" and "and the day".
export function setup(std = stdSource()) {
  const lines = std.split("\n");
  const from = lines.findIndex((l) => l.includes("The examples may use these:"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("# and the day"));
  return lines.slice(from + 1, to).map((l) => l.replace(/^#   ?/, "").replace(/^#$/, "")).join("\n").trim();
}
export const EXAMPLE_TODAY = "2026-11-09";

// The entries a word finds: by a function's name, then by its section's or what it gives; no word, every entry.
export function find(word = "") {
  const w = word.toLowerCase();
  const all = LIBRARY.map((entry) => ({ ...entry, examples: examples().filter((x) => entry.names.includes(x.name)) }));
  if (!w) return all;
  const named = all.filter((e) => e.names.some((n) => n.includes(w)));
  return [...named, ...all.filter((e) => !named.includes(e) && `${e.section} ${e.gives}`.toLowerCase().includes(w))];
}
