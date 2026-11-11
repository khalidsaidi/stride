// node scripts/selftest.mjs: Stride's conformance suite, the programs in tests/. Each test names the rules of
// the specification (docs/spec.md) it tests, and says in its comments what must happen to it:
//
//   # rule 6.4.1 S413                     the spec's rules and codes it tests (every test names at least one)
//   # mistake 4:12 S201 nothing called    a mistake at line 4, column 12, with its code and words of its message
//                                         (column, code and words may each be left out: # mistake 4 S201; words
//                                         ending in $ are the message's end: # mistake 4 S201 defined here$)
//   # label 5:15-5:21 no field nmae      a label some mistake carries (the place's first), with its span and words
//   # warning 7 W002                      the same for a warning
//   # engines vm                          only these of vm, ir (resource limits, §19.1.2)
//   # header-pdf <sha256>, # header-form <id>   the header is for this PDF or form, not the program's (S501, S502)
//   # std <file>                          this standard library (in tests/lib/) instead of lib/std.stride
//   # box Name text|check|radio:on|choice:a,b near words   the header's boxes; without any, every box the
//                                         program writes is made a text or check box, with every printed word
//                                         beside it
//
// Then one run, or several, each starting at its own `# run name`; these say what the run gives:
//
//   # answers {"n": 3, "name": "Ada"}     the answers (numbers kept to the digit: they reach the machine as the
//                                         words written, §8.7)
//   # today 2026-11-07                    today() for the run
//   # boxes {"A": "Ada", "B": "Off"}      the boxes after it (every other box the program writes empty)
//   # asked ["n", "name"]                 the questions reached, by key, in order, and no other
//   # steps [{"key": "n", "value": 3, "default": 1, "failed": ["…"], "unreadable": null}, …]
//                                         the questions reached, in order, each with what it lists
//   # prints ["Ada", "3"]                 the words given to print, in order
//   # fault F001 at 7:12 division         the run stops on this fault (code, place and words optional)
//   # stack ["half t.stride:3:12", "main t.stride:7:12"]   … with this logical stack, innermost first: function file:line:column
//
// A machine test (`machine/*.mjs`, §19.3) hands the machine bytecode built by hand and names the fault it must stop
// with. A test file (`*.test.stride`, §4.3) runs its expectations; every one must pass, or, with
//   # results ["pass", "fail", "not run"]
// give exactly these results in order.
//
// A test with mistakes expected passes when exactly those mistakes and warnings are reported. A test with none
// must compile clean, and every run then goes through both engines — the machine and the intermediate form's
// interpreter — which must give
// the golden results above and agree with each other on every question, box, print and fault (§19.1).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { compile } from "./compile.mjs";
import { load, run, boxValues } from "../runtime/vm.mjs";
import { interpretProgram } from "./interpret.mjs";
import { parseDigits, expectResults } from "./test.mjs";
import { Diagnostics, SourceFile } from "./source.mjs";
import { parse } from "./parse.mjs";
import { format, comments } from "./format.mjs";
import { textOf } from "../runtime/natives.mjs";
import * as IR from "./ir.mjs";
import { fileURLToPath } from "node:url";

const PDF = "0".repeat(64);
const here = fileURLToPath(new URL(".", import.meta.url));
// Beside this file when run from the repository; from the one executable, the repository's own, from where it is
// run.
export const TESTS = existsSync(join(here, "../tests")) ? join(here, "../tests") : join(process.cwd(), "tests");
export const SPEC = existsSync(join(here, "../docs/spec.md")) ? join(here, "../docs/spec.md") : join(process.cwd(), "docs/spec.md");
export const MODES = ["vm", "ir"];

// JSON with every number kept as the digits written, as words: what a run's boxes and steps are compared with.
export const parseExact = (text) => JSON.parse(text, (k, v, context) => (typeof v === "number" ? context.source : v));

// A value as the tests compare it: its words (§3.5) for a scalar, lists item by item, records field by field.
export function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && Array.isArray(v.fields)) return { [v.type]: v.fields.map(canon) };
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return textOf(v);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The expectations a test's comments state.
export function expectations(text) {
  const out = { rules: [], mistakes: [], warnings: [], labels: [], header: [], engines: null, results: null, runs: [] };
  let current = null;
  const runOf = () => {
    if (!current) out.runs.push((current = { name: "run", answers: {} }));
    return current;
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = raw.match(/^\s*#\s*(rule|mistake|warning|label|engines|header-pdf|header-form|std|box|results|run|answers|today|boxes|asked|steps|prints|fault|stack)(?![\w-])\s*(.*)$/);
    if (!m) continue;
    const [, kind, rest] = m;
    switch (kind) {
      case "rule":
        out.rules.push(...rest.split(/[\s,]+/).filter(Boolean));
        break;
      case "mistake":
      case "warning": {
        const p = rest.match(/^(\d+)(?::(\d+))?(?:\s+([SWF]\d{3}))?\s*(.*)$/);
        if (!p) throw new Error(`a ${kind} expectation needs a line: # ${kind} 4:12 S201 words`);
        out[`${kind}s`].push({ line: Number(p[1]), column: p[2] ? Number(p[2]) : null, code: p[3] ?? null, words: p[4].trim() });
        break;
      }
      case "label": {
        const p = rest.match(/^(\d+):(\d+)-(\d+):(\d+)\s+(.*)$/);
        if (!p) throw new Error(`a label expectation is # label 5:15-5:21 words: ${rest}`);
        out.labels.push({ line: Number(p[1]), column: Number(p[2]), endLine: Number(p[3]), endColumn: Number(p[4]), words: p[5].trim() });
        break;
      }
      case "std":
        out.std = rest.trim();
        break;
      case "header-pdf":
        out.headerPdf = rest.trim();
        break;
      case "header-form":
        out.headerForm = rest.trim();
        break;
      case "engines":
        out.engines = rest.split(/[\s,]+/).filter(Boolean);
        break;
      case "box": {
        const p = rest.match(/^(\S+)\s+(text|check|radio:\S+|choice:\S+)(?:\s+near\s+(.*))?$/);
        if (!p) throw new Error(`# box Name text|check|radio:on|choice:a,b [near words]: ${rest}`);
        const [what, arg] = p[2].split(":");
        const box = { field: p[1], kind: what, near: p[3] ? [p[3]] : [], page: 1 };
        if (what === "radio") box.on = arg;
        if (what === "check") box.on = "Yes";
        if (what === "choice") box.options = arg.split(",");
        out.header.push(box);
        break;
      }
      case "results":
        out.results = JSON.parse(rest);
        break;
      case "run":
        out.runs.push((current = { name: rest.trim() || `run ${out.runs.length + 1}`, answers: {} }));
        break;
      case "answers":
        runOf().answers = parseDigits(rest); // as answers.json is read (§8.7)
        break;
      case "today":
        runOf().today = rest.trim();
        break;
      case "boxes":
        runOf().boxes = parseExact(rest);
        break;
      case "asked":
        runOf().asked = JSON.parse(rest);
        break;
      case "steps":
        runOf().steps = parseExact(rest);
        break;
      case "prints":
        runOf().prints = JSON.parse(rest);
        break;
      case "fault": {
        const p = rest.match(/^(F\d{3})?(?:\s*at\s+(\d+):(\d+))?\s*(.*)$/);
        runOf().fault = { code: p[1] ?? null, line: p[2] ? Number(p[2]) : null, column: p[3] ? Number(p[3]) : null, words: p[4].trim() };
        break;
      }
      case "stack":
        runOf().stack = JSON.parse(rest);
        break;
    }
  }
  if (!out.runs.length) out.runs.push({ name: "run", answers: {} });
  return out;
}

// A header made from the program itself, for a test that lists no boxes: every box it names written out, and every
// box it writes on the answers given (a name worked out as it runs), each of the kind its statement writes.
export function autoHeader(source, name, options = {}, runs = [{}]) {
  const first = compile(source, name, { dir: TESTS, header: { form: null, pdf: PDF, boxes: [], open: true }, ...options });
  if (!first.program) return { form: "test", pdf: PDF, boxes: [] };
  const found = new Map(); // full name (and a radio's button) -> a header's box
  const add = (field, kind, button) => {
    if (kind === "pick") found.set(`${field}\t${button}`, { field, kind: "radio", on: button, page: 1 });
    else if (!found.has(field)) found.set(field, kind === "tick" ? { field, kind: "check", on: "Yes", page: 1 } : { field, kind: "text", page: 1 });
  };
  for (const fn of first.program.functions) {
    for (const b of fn.blocks) {
      for (const s of b.stmts) {
        if (!["fill", "tick", "pick"].includes(s.op) || !IR.isConst(s.box)) continue;
        if (s.op !== "pick") add(first.program.prefix + textOf(s.box.v), s.op, null);
        else if (IR.isConst(s.button)) add(first.program.prefix + textOf(s.box.v), "pick", textOf(s.button.v));
      }
    }
  }
  if (first.diagnostics.empty && !first.program.test && !first.program.script) {
    for (const answers of runs) {
      try {
        interpretProgram(first.program, answers, new Map(), { onWrite: add });
      } catch {
        // What it reached is what is known of it.
      }
    }
  }
  return { form: first.program.form, pdf: first.program.pdf, boxes: [...found.values()] };
}

// One run in one mode, as the comparisons see it.
function runMode(mode, compiled, answers, today) {
  const program = compiled.out.program;
  const tests = (r) => (program.test ? expectResults(program, r.results ?? []) : null);
  if (mode.startsWith("vm")) {
    const p = compiled.loaded;
    const r = run(p, answers, { today });
    return { steps: r.steps, boxes: boxValues(p, r.writes), prints: r.prints ?? [], fault: r.fault, results: tests(r) };
  }
  const r = interpretProgram(program, answers, compiled.out.boxes, { today });
  const boxes = {};
  for (const [k, w] of r.writes) boxes[k] = w;
  return { steps: r.steps, boxes, prints: r.prints ?? [], fault: r.fault, results: tests(r) };
}

const stepView = (s) => ({ key: s.key, printed: s.printed, value: canon(s.value), default: s.default === undefined ? undefined : canon(s.default), failed: s.failed ?? [], unreadable: s.unreadable ?? null });
// A fault as the comparisons see it: the file it stands in, and each frame's file, are part of it.
const faultView = (f) => (f ? { code: f.code ?? null, message: f.message ?? f.reason ?? "", file: f.file ?? null, line: f.line ?? null, column: f.column ?? null, stack: (f.stack ?? []).map((x) => `${x.function} ${x.file ?? ""}:${x.line}:${x.column ?? 0}`) } : null);

// Compares one mode's run with the golden results; gives what differs.
function golden(want, got, prefix, mode) {
  const problems = [];
  const say = (m) => problems.push(`${want.name}, ${mode}: ${m}`);
  if (want.fault) {
    const f = faultView(got.fault);
    if (!f) say(`expected the fault ${want.fault.code ?? ""} ${want.fault.words}, and the run ended`);
    else {
      if (want.fault.code && f.code !== want.fault.code) say(`expected the fault ${want.fault.code}, got ${f.code} ${f.message}`);
      if (want.fault.words && !f.message.includes(want.fault.words)) say(`expected the fault's message to hold "${want.fault.words}", got "${f.message}"`);
      if (want.fault.line && (f.line !== want.fault.line || (want.fault.column && f.column !== want.fault.column))) say(`expected the fault at ${want.fault.line}:${want.fault.column}, got ${f.line}:${f.column}`);
      if (want.stack && !same(f.stack, want.stack)) say(`expected the stack ${JSON.stringify(want.stack)}, got ${JSON.stringify(f.stack)}`);
    }
  } else if (got.fault && !(got.results && want.results?.includes("not run"))) say(`the run stopped: ${got.fault.code ?? ""} ${got.fault.message} (line ${got.fault.line})`);
  if (want.boxes) {
    const expected = Object.fromEntries(Object.entries(want.boxes).map(([k, v]) => [prefix + k, v === null ? "" : String(v)]));
    for (const [k, v] of Object.entries(expected)) if ((got.boxes[k] ?? "") !== v) say(`box ${k} holds ${JSON.stringify(got.boxes[k])}, expected ${JSON.stringify(v)}`);
    for (const [k, v] of Object.entries(got.boxes)) if (!(k in expected) && v !== "" && v !== "Off") say(`box ${k} holds ${JSON.stringify(v)}, expected empty`);
  }
  const keys = got.steps.map((s) => s.key);
  if (want.asked && !same(keys, want.asked)) say(`asked ${JSON.stringify(keys)}, expected ${JSON.stringify(want.asked)}`);
  if (want.steps) {
    if (got.steps.length !== want.steps.length) say(`reached ${got.steps.length} questions, expected ${want.steps.length}: ${JSON.stringify(keys)}`);
    want.steps.forEach((w, i) => {
      const g = got.steps[i] ? stepView(got.steps[i]) : null;
      if (!g) return;
      for (const [k, v] of Object.entries(w)) {
        const expected = k === "value" || k === "default" ? canon(v) : v;
        if (!same(g[k], expected)) say(`question ${i + 1} (${g.key}): ${k} is ${JSON.stringify(g[k])}, expected ${JSON.stringify(expected)}`);
      }
    });
  }
  // A test file: its expectations' results, or every one passing.
  if (got.results) {
    const results = got.results.map((r) => r.result);
    const expected = want.results ?? results.map(() => "pass");
    if (!same(results, expected)) say(`results ${JSON.stringify(results)}, expected ${JSON.stringify(expected)}: ${got.results.map((r, i) => (r.why ? `${i + 1} (line ${r.line}) ${r.why}` : null)).filter(Boolean).join("; ")}`);
  }
  if (want.prints && !same(got.prints, want.prints)) say(`printed ${JSON.stringify(got.prints)}, expected ${JSON.stringify(want.prints)}`);
  return problems;
}

// What every mode must agree on (§19.1).
function agreement(results) {
  // Boxes by name, whatever order an engine wrote them in.
  const view = (r) => JSON.stringify({ steps: r.steps.map(stepView), boxes: Object.fromEntries(Object.entries(r.boxes).filter(([, v]) => v !== "" && v !== "Off").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), prints: r.prints, fault: faultView(r.fault), results: r.results });
  const [first, ...rest] = Object.entries(results);
  const problems = [];
  if (!first) return problems;
  for (const [mode, r] of rest) if (view(r) !== view(first[1])) problems.push(`compiler fault: ${mode} and ${first[0]} disagree: ${view(r)} vs ${view(first[1])}`);
  return problems;
}

// `stride fmt` keeps a file's meaning (§17): the formatted text parses to the same tree, and formatting it again
// changes nothing. A file that does not parse is left as it is.
export function formatProblems(text, name) {
  const start = name.endsWith(".test.stride") ? "Test" : /^\s*(#[^\n]*\n\s*)*form\s/.test(text) ? "Program" : "Library";
  const tree = (t) => {
    const d = new Diagnostics();
    const out = parse(new SourceFile(name, t), d, start);
    return out ? JSON.stringify(out, (k, v) => (["span", "opSpan", "pathSpan", "nameSpan", "bareSpan", "raw", "parenthesised"].includes(k) ? undefined : v)) : null;
  };
  const before = tree(text);
  if (before === null) return [];
  let once;
  try {
    once = format(text, name).text;
  } catch (e) {
    return [`stride fmt fails on it: ${e.message}`];
  }
  if (once === null || tree(once) !== before) return ["stride fmt changes what it means"];
  // Comments are kept (§17): a comment on its own line (a test's directives among them) stays on its own line, in
  // order; a comment after code may move or join another, but every one of its words stays in a comment.
  const was = comments(text), now = comments(once);
  const own = (list) => list.filter((c) => !c.trailing).map((c) => c.text).join("\n");
  if (own(was) !== own(now)) return ["stride fmt does not keep the comments on their own lines"];
  const after = now.filter((c) => c.trailing).map((c) => c.text).join(" ");
  if (was.filter((c) => c.trailing).some((c) => !after.includes(c.text))) return ["stride fmt loses a comment after code"];
  if (format(once, name).text !== once) return ["stride fmt gives another layout when run again"];
  return [];
}

export function runOne(path) {
  // The compiler is given the file's bytes, as it is on the disk: it checks they are UTF-8 (§1.1).
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  const name = path.split("/").pop();
  const want = expectations(text);
  const problems = [];
  if (!want.rules.length) problems.push("the test names no rule (# rule 6.4.1)");
  const header = want.header.length ? { form: null, pdf: (text.match(/^\s*pdf\s+([0-9a-f]{64})/m) ?? [])[1] ?? PDF, boxes: want.header } : autoHeader(bytes, name, {}, want.runs.map((r) => r.answers ?? {}));
  if (want.headerPdf) header.pdf = want.headerPdf;
  if (want.headerForm) header.form = want.headerForm;
  const std = want.std ? { stdPath: join(TESTS, "lib", want.std) } : {};
  const out = compile(bytes, name, { dir: TESTS, header, ...std });
  const got = out.diagnostics.sorted();
  problems.push(...formatProblems(text, name));

  // Mistakes and warnings: each expected one reported, and nothing else.
  for (const [kind, list] of [["error", want.mistakes], ["warning", want.warnings]]) {
    const reported = got.filter((d) => d.severity === kind);
    const used = new Set();
    for (const w of list) {
      const i = reported.findIndex((d, j) => !used.has(j) && d.line === w.line && (w.column === null || d.column === w.column) && (!w.code || d.code === w.code) && (w.words.endsWith("$") ? d.message.endsWith(w.words.slice(0, -1)) : d.message.includes(w.words)));
      if (i < 0) problems.push(`expected the ${kind === "error" ? "mistake" : "warning"} ${w.line}${w.column ? `:${w.column}` : ""} ${w.code ?? ""} "${w.words}"`);
      else used.add(i);
    }
    reported.forEach((d, j) => {
      if (!used.has(j)) problems.push(`unexpected ${kind === "error" ? "mistake" : "warning"} ${d.line}:${d.column} ${d.code ?? ""} ${d.message}`);
    });
  }
  // Labels (§16.2): each expected one is on some mistake or warning, as --json gives it, the place's first.
  const labels = got.flatMap((d) => d.toJSON().labels);
  for (const w of want.labels) {
    if (!labels.some((l) => l.line === w.line && l.column === w.column && l.endLine === w.endLine && l.endColumn === w.endColumn && l.message === w.words)) problems.push(`expected the label ${w.line}:${w.column}-${w.endLine}:${w.endColumn} "${w.words}"; the labels are ${labels.map((l) => `${l.line}:${l.column}-${l.endLine}:${l.endColumn} "${l.message}"`).join(", ")}`);
  }
  if (want.mistakes.length || problems.length) return { name, rules: want.rules, problems };
  if (!out.bytecode) problems.push("no bytecode, and no mistake expected");
  if (problems.length) return { name, rules: want.rules, problems };

  const compiled = { out, loaded: load(out.bytecode) };
  const modes = want.engines ?? MODES;
  for (const r of want.runs) {
    const results = {};
    for (const mode of modes) {
      try {
        results[mode] = runMode(mode, compiled, r.answers, r.today ?? null);
      } catch (e) {
        problems.push(`${r.name}, ${mode}: the engine broke: ${e.message}`);
        continue;
      }
      problems.push(...golden({ ...r, results: want.results }, results[mode], compiled.loaded.prefix, mode));
    }
    if (!want.engines) problems.push(...agreement(results));
  }
  return { name, rules: want.rules, problems: [...new Set(problems)] };
}

// A machine test (§19.3): bytecode built by hand (`bytecode`), run in the machine, which must stop with `fault`.
const require = createRequire(import.meta.url);
export function runMachine(path) {
  const name = `machine/${path.split("/").pop()}`;
  const rules = (readFileSync(path, "utf8").match(/^\/\/ rule (.*)$/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const problems = [];
  if (!rules.length) problems.push("the test names no rule (// rule F006)");
  const m = require(path);
  // Bytecode the loader must refuse (§18.3): `refused` holds words of its reason.
  if (m.refused) {
    try {
      load(m.bytecode);
      problems.push(`expected the loader to refuse it (${m.refused}), and it loaded`);
    } catch (e) {
      if (!String(e.message).includes(m.refused)) problems.push(`expected the loader to refuse it for "${m.refused}", got "${e.message}"`);
    }
    return { name, rules, problems };
  }
  const r = run(load(m.bytecode), {});
  if (r.fault?.code !== m.fault) problems.push(`expected the fault ${m.fault}, got ${r.fault ? `${r.fault.code} ${r.fault.message}` : "none"}`);
  return { name, rules, problems };
}

// Every test's name, as `node scripts/selftest.mjs <name>` matches it: cli/…, machine/… and the programs.
export function testNames(dir = TESTS) {
  const sub = (d) => (existsSync(join(dir, d)) ? readdirSync(join(dir, d)).filter((f) => f.endsWith(".mjs")).map((f) => `${d}/${f}`) : []);
  return [...sub("cli"), ...sub("machine"), ...readdirSync(dir).filter((f) => f.endsWith(".stride"))];
}

export function selftest(dir = TESTS, only = []) {
  const wanted = (f) => !only.length || only.some((o) => f.includes(o));
  const cli = existsSync(join(dir, "cli")) ? readdirSync(join(dir, "cli")).filter((f) => f.endsWith(".mjs") && wanted(`cli/${f}`)).sort() : [];
  const cliResults = cli.map((f) => {
    const path = join(dir, "cli", f);
    let rules = [];
    try {
      rules = (readFileSync(path, "utf8").match(/^\/\/ rule (.*)$/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
      const problems = require(path).test();
      if (!rules.length) problems.push("the test names no rule (// rule 18.2)");
      return { name: `cli/${f}`, rules, problems };
    } catch (e) {
      return { name: `cli/${f}`, rules, problems: [`the test itself is broken: ${e.stack}`] };
    }
  });
  const machine = existsSync(join(dir, "machine")) ? readdirSync(join(dir, "machine")).filter((f) => f.endsWith(".mjs") && wanted(`machine/${f}`)).sort() : [];
  const machineResults = machine.map((f) => {
    try {
      return runMachine(join(dir, "machine", f));
    } catch (e) {
      return { name: `machine/${f}`, rules: [], problems: [`the test itself is broken: ${e.stack}`] };
    }
  });
  const files = readdirSync(dir).filter((f) => f.endsWith(".stride") && wanted(f)).sort();
  return [...cliResults, ...machineResults, ...files.map((f) => {
    // The rules a test names count for coverage even when the test cannot run yet.
    let rules = [];
    try {
      rules = expectations(readFileSync(join(dir, f), "utf8")).rules;
      return runOne(join(dir, f));
    } catch (e) {
      return { name: f, rules, problems: [`the test itself is broken: ${e.stack}`] };
    }
  })];
}

// The spec's rules and codes: every numbered rule (`6.4.1.`) and every mistake, warning and fault code.
export function specRules(path = SPEC) {
  const text = readFileSync(path, "utf8");
  const rules = new Set();
  for (const m of text.matchAll(/^(?:- )?(\d+(?:\.\d+)+)\./gm)) rules.add(m[1]);
  // The library's sections (### 14.1 Words …) are rules too: every function in them is tested.
  for (const m of text.matchAll(/^### (\d+(?:\.\d+)+) /gm)) rules.add(m[1]);
  for (const m of text.matchAll(/^\| ([SFW]\d{3}) \|/gm)) rules.add(m[1]);
  return [...rules];
}

// Which rules no test names, and which names name no rule.
export function coverage(results, path = SPEC) {
  const rules = specRules(path);
  const named = new Set(results.flatMap((r) => r.rules));
  // A rule conforms when it has a test and every test naming it passes: inventory is not conformance.
  const failing = new Set(results.filter((r) => r.problems.length).flatMap((r) => r.rules));
  const passing = rules.filter((r) => named.has(r) && !failing.has(r));
  return { rules, untested: rules.filter((r) => !named.has(r)), unknown: [...named].filter((r) => !rules.includes(r)), passing, failing: rules.filter((r) => failing.has(r)) };
}
