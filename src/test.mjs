// `stride test`: a program's tests, each a file in <form>.tests/ beside it:
//
//   {
//     "answers": { "taxpayer_name": "Ada Lovelace", "representatives[1].name": "Bob", … },
//     "boxes":   { "Page1[0].TaxpayerName[0]": "Ada Lovelace", "Page1[0].SentCopies1[0]": "1", … },
//     "asked":   ["taxpayer_name", …],     optional: questions that must be asked, in this order
//     "unasked": ["deletions_2", …],       optional: questions that must not be asked
//     "loose":   true                      optional: boxes not listed may hold anything
//     "today":   "2026-11-07"              optional: the date today() gives
//     "prints":  ["Hello, Ada"]            optional: every line the run prints, in order
//     "fault":   "F013"                    optional: the run stops with this fault; else it must not stop
//   }
//
// Box names are as the program writes them (without its fields prefix). Without "loose", every box the test does
// not list must be empty ("" or "Off"): a test says all of what the form holds after those answers.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { run, boxValues } from "../runtime/vm.mjs";
import { dateFrom, D } from "../runtime/values.mjs";
import { interpretProgram } from "./interpret.mjs";

export function testsOf(programPath) {
  const dir = programPath.replace(/\.(stride|sbc)$/, ".tests");
  if (!existsSync(dir)) return { dir, files: [] };
  return { dir, files: readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) };
}

// Runs one test on a loaded program; gives the list of what differs (empty when it passes). With the program's
// intermediate form (`ir`: { program, boxes }), the test runs there too, and any difference between the two runs
// is a fault in the compiler, said as such.
export function runTest(p, test, ir = null, override = null) {
  const problems = [];
  const today = test.today ?? override;
  const result = run(p, test.answers ?? {}, { today });
  if (ir) problems.push(...crossCheck(p, result, interpretProgram(ir.program, test.answers ?? {}, ir.boxes, { today })));
  if (test.fault !== undefined && result.fault?.code !== test.fault) problems.push(result.fault ? `the run stopped with ${result.fault.code}, expected ${test.fault}` : `the run finished, expected it to stop with ${test.fault}`);
  if (test.prints !== undefined && JSON.stringify(result.prints) !== JSON.stringify(test.prints)) problems.push(`the run printed ${JSON.stringify(result.prints)}, expected ${JSON.stringify(test.prints)}`);
  if (result.fault && test.fault === undefined) problems.push(`the run stopped: ${result.fault.message} (${result.fault.file}:${result.fault.line})${(result.fault.stack ?? []).slice(1).map((f) => `, called from ${f.function} at ${f.file}:${f.line}`).join("")}`);
  const values = boxValues(p, result.writes);
  const short = (name) => (name.startsWith(p.prefix) ? name.slice(p.prefix.length) : name);
  const expected = new Map(Object.entries(test.boxes ?? {}).map(([k, v]) => [k.startsWith(p.prefix) ? k : p.prefix + k, String(v)]));
  for (const [name, want] of expected) {
    if (!(name in values)) {
      problems.push(`the program writes no box "${short(name)}"`);
      continue;
    }
    if (values[name] !== want) problems.push(`"${short(name)}" holds ${JSON.stringify(values[name])}, expected ${JSON.stringify(want)}`);
  }
  if (!test.loose) {
    for (const [name, got] of Object.entries(values)) {
      if (expected.has(name)) continue;
      if (got !== "" && got !== "Off") problems.push(`"${short(name)}" holds ${JSON.stringify(got)}, and the test expects it empty`);
    }
  }
  const asked = result.steps.map((s) => s.key);
  if (test.asked) {
    let at = 0;
    for (const key of test.asked) {
      const i = asked.indexOf(key, at);
      if (i < 0) problems.push(asked.includes(key) ? `${key} is asked, but not in the order the test gives` : `${key} is not asked`);
      else at = i + 1;
    }
  }
  for (const key of test.unasked ?? []) if (asked.includes(key)) problems.push(`${key} is asked, and the test says it is not`);
  for (const key of Object.keys(test.answers ?? {})) if (!asked.includes(key) && !(test.unasked ?? []).includes(key)) problems.push(`the test answers ${key}, which the program does not ask`);
  return { problems, steps: result.steps, values };
}

// The machine's run against the intermediate form's, everything §19.1 compares: the questions reached with their
// keys, printed words, values, defaults, checks and unreadable marks; every print; the fault, its code, message and
// every place of its stack; and, when the run did not stop, every box. Any difference is a fault in the compiler.
function crossCheck(p, vm, ir) {
  const out = [];
  const fault = (f) => (f ? JSON.stringify({ code: f.code, message: f.message, stack: (f.stack ?? []).map((x) => [x.function, x.file, x.line, x.column]) }) : "none");
  if (fault(vm.fault) !== fault(ir.fault)) out.push(`compiler fault: the machine stops with ${fault(vm.fault)} and the intermediate form with ${fault(ir.fault)}`);
  const steps = (r) => r.steps.map((s) => JSON.stringify([s.key, s.printed, s.value, s.default, s.failed, s.unreadable ?? null]));
  const [a, b] = [steps(vm), steps(ir)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    out.push(`compiler fault: question ${i + 1} is ${a[i] ?? "not asked"} in the machine and ${b[i] ?? "not asked"} in the intermediate form`);
    break;
  }
  if (JSON.stringify(vm.prints) !== JSON.stringify(ir.prints)) out.push(`compiler fault: the machine prints ${JSON.stringify(vm.prints)} and the intermediate form ${JSON.stringify(ir.prints)}`);
  if (vm.fault || ir.fault) return out;
  const values = boxValues(p, vm.writes);
  for (const [name, v] of Object.entries(values)) {
    const kind = p.boxes.find((x) => x.name === name)?.kind;
    const w = ir.writes.has(name) ? ir.writes.get(name) : kind === "fill" ? "" : "Off";
    if (w !== v) out.push(`compiler fault: "${name.slice(p.prefix.length)}" holds ${JSON.stringify(v)} in the machine and ${JSON.stringify(w)} in the intermediate form`);
  }
  for (const name of ir.writes.keys()) if (!(name in values)) out.push(`compiler fault: the intermediate form writes "${name.slice(p.prefix.length)}", which the machine does not`);
  return out;
}

// A test file's expectations, in order (§7.17.1): those a fault in a let kept from running are "not run".
export function expectResults(program, results) {
  const count = program.main.blocks.reduce((n, b) => n + b.stmts.filter((s) => s.op === "expect").length, 0);
  return [...results, ...Array.from({ length: Math.max(0, count - results.length) }, () => ({ result: "not run" }))];
}

// JSON whose numbers are kept as their digits as written (§8.7: answers are never read through a binary float,
// so 12345678901234567890.25 stays exact). Needs JSON.parse's source text, which Node gives the reviver.
// A JSON number keeps its token as written, apart from words in quotes (§8.7): `1e5` and `"1e5"` differ.
export const parseDigits = (text) => JSON.parse(text, (k, v, context) => (typeof v === "number" ? new D.JsonNumber(context.source) : v));

// `today`: the --today date, for the tests that do not give their own. Every test's own date is checked before any
// test runs (§17.1): `usage` lists the bad ones, and then nothing runs.
export function runTests(p, programPath, only = [], ir = null, { today = null } = {}) {
  const { dir, files } = testsOf(programPath);
  const loaded = [];
  for (const file of files) {
    const name = basename(file, ".json");
    if (only.length && !only.includes(name)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const test = JSON.parse(text);
      test.answers = parseDigits(text).answers;
      loaded.push({ name, file, test });
    } catch (e) {
      loaded.push({ name, file, problems: [`not JSON: ${e.message}`] });
    }
  }
  // A name no test has names nothing: a usage mistake too (§17.4).
  const names = new Set(files.map((f) => basename(f, ".json")));
  const usage = [
    ...only.filter((n) => !names.has(n)).map((n) => `there is no test ${n} in ${dir}`),
    ...loaded.filter((x) => x.test && "today" in x.test && todayMistake(x.test.today)).map((x) => `${x.file}: "today" ${todayMistake(x.test.today, "today")}`),
  ];
  if (usage.length) return { dir, results: [], usage };
  const results = loaded.map((x) => (x.test ? { name: x.name, file: x.file, ...runTest(p, x.test, ir, today) } : x));
  return { dir, results };
}

// What is wrong with a --today value, or null when it is a real day (§17): for --today and for a test's "today".
export function todayMistake(v, what = "--today") {
  if (v === undefined || (typeof v === "string" && v.startsWith("--"))) return `needs a date: ${what} YYYY-MM-DD`;
  if (typeof v !== "string") return `takes a date written YYYY-MM-DD, and this is ${JSON.stringify(v)}`;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `takes a date written YYYY-MM-DD, and this is "${v}"`;
  if (Number(m[1]) < 1) return `takes a year from 0001 to 9999, and this is "${v}"`;
  if (!dateFrom(v)) return `"${v}" is no such day`;
  return null;
}
